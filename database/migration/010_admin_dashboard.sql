BEGIN;

CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_customer ON feedback (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGSERIAL PRIMARY KEY,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('new_order', 'customer_request', 'notification_failure', 'system')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source_key TEXT UNIQUE,
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  request_id BIGINT REFERENCES admin_requests(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_unread
  ON admin_notifications (created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('received', 'preparing', 'out_for_delivery', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order
  ON order_status_history (order_id, created_at);

CREATE TABLE IF NOT EXISTS admin_profile (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Administrator',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_profile (id, display_name)
VALUES (1, 'Administrator')
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_status_history (order_id, status, created_at)
SELECT o.id, o.status, o.created_at
FROM orders o
WHERE NOT EXISTS (
  SELECT 1 FROM order_status_history h WHERE h.order_id = o.id
);

INSERT INTO admin_notifications (
  notification_type, title, message, source_key, order_id, customer_id, created_at
)
SELECT
  'new_order',
  'New order #' || o.id,
  COALESCE(c.name, c.whatsapp_phone, 'Customer') || ' placed a ' || o.order_type || ' order.',
  'order:' || o.id,
  o.id,
  o.customer_id,
  o.created_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO admin_notifications (
  notification_type, title, message, source_key, request_id, order_id, customer_id, created_at
)
SELECT
  'customer_request',
  'Customer request #' || r.id,
  r.question,
  'request:' || r.id,
  r.id,
  r.order_id,
  r.customer_id,
  r.created_at
FROM admin_requests r
ON CONFLICT (source_key) DO NOTHING;

CREATE OR REPLACE FUNCTION dashboard_order_event() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_status_history (order_id, status, created_at)
    VALUES (NEW.id, NEW.status, NEW.created_at);

    INSERT INTO admin_notifications (
      notification_type, title, message, source_key, order_id, customer_id, created_at
    )
    SELECT
      'new_order',
      'New order #' || NEW.id,
      COALESCE(c.name, c.whatsapp_phone, 'Customer') || ' placed a ' || NEW.order_type || ' order.',
      'order:' || NEW.id,
      NEW.id,
      NEW.customer_id,
      NEW.created_at
    FROM customers c WHERE c.id = NEW.customer_id
    ON CONFLICT (source_key) DO NOTHING;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_status_history (order_id, status, created_at)
    VALUES (NEW.id, NEW.status, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_order_event ON orders;
CREATE TRIGGER trg_dashboard_order_event
AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION dashboard_order_event();

CREATE OR REPLACE FUNCTION dashboard_request_event() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO admin_notifications (
      notification_type, title, message, source_key, request_id, order_id, customer_id, created_at
    ) VALUES (
      'customer_request',
      'Customer request #' || NEW.id,
      NEW.question,
      'request:' || NEW.id,
      NEW.id,
      NEW.order_id,
      NEW.customer_id,
      NEW.created_at
    ) ON CONFLICT (source_key) DO NOTHING;
  ELSIF NEW.notification_sent = FALSE
    AND NEW.notification_error IS NOT NULL
    AND (OLD.notification_error IS DISTINCT FROM NEW.notification_error OR OLD.notification_sent = TRUE) THEN
    INSERT INTO admin_notifications (
      notification_type, title, message, source_key, request_id, order_id, customer_id
    ) VALUES (
      'notification_failure',
      'Customer notification failed',
      'Request #' || NEW.id || ' could not notify the customer.',
      'request-notification-failed:' || NEW.id,
      NEW.id,
      NEW.order_id,
      NEW.customer_id
    ) ON CONFLICT (source_key) DO UPDATE
      SET message = EXCLUDED.message, read_at = NULL, created_at = NOW();
  ELSIF NEW.notification_sent = TRUE AND OLD.notification_sent = FALSE THEN
    DELETE FROM admin_notifications
    WHERE source_key = 'request-notification-failed:' || NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_request_event ON admin_requests;
CREATE TRIGGER trg_dashboard_request_event
AFTER INSERT OR UPDATE OF notification_sent, notification_error ON admin_requests
FOR EACH ROW EXECUTE FUNCTION dashboard_request_event();

COMMIT;
