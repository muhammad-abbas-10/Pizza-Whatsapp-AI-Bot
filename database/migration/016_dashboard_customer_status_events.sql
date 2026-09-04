BEGIN;

-- One canonical vocabulary and transition policy for every caller.  The
-- backend asks these functions instead of maintaining a second transition
-- matrix, and n8n only communicates state already accepted by PostgreSQL.
CREATE OR REPLACE FUNCTION canonical_order_statuses()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'received',
    'preparing',
    'oven',
    'out_for_delivery',
    'completed',
    'cancelled'
  ]::TEXT[];
$$;

CREATE OR REPLACE FUNCTION is_canonical_order_status(candidate TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT candidate = ANY(canonical_order_statuses());
$$;

CREATE OR REPLACE FUNCTION allowed_order_status_transitions(current_status TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE current_status
    WHEN 'received' THEN ARRAY['preparing', 'cancelled']::TEXT[]
    WHEN 'preparing' THEN ARRAY['oven', 'cancelled']::TEXT[]
    -- Pickup orders may complete at the counter; delivery orders normally
    -- continue through out_for_delivery.  Both are explicit forward moves.
    WHEN 'oven' THEN ARRAY['out_for_delivery', 'completed']::TEXT[]
    WHEN 'out_for_delivery' THEN ARRAY['completed']::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION can_transition_order_status(from_status TEXT, to_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT to_status = ANY(allowed_order_status_transitions(from_status));
$$;

CREATE OR REPLACE FUNCTION allowed_order_status_transitions_for_order(
  current_status TEXT,
  fulfilment_type TEXT
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN current_status = 'oven' AND fulfilment_type = 'delivery'
      THEN ARRAY['out_for_delivery']::TEXT[]
    WHEN current_status = 'oven' AND fulfilment_type = 'pickup'
      THEN ARRAY['completed']::TEXT[]
    ELSE allowed_order_status_transitions(current_status)
  END;
$$;

CREATE OR REPLACE FUNCTION can_transition_order_status_for_order(
  from_status TEXT,
  to_status TEXT,
  fulfilment_type TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT to_status = ANY(allowed_order_status_transitions_for_order(from_status, fulfilment_type));
$$;

CREATE OR REPLACE FUNCTION order_is_cancellable(current_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT current_status IN ('received', 'preparing');
$$;

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT can_transition_order_status_for_order(OLD.status, NEW.status, OLD.order_type) THEN
    RAISE EXCEPTION 'Invalid order status transition from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('received', 'preparing', 'oven', 'out_for_delivery', 'completed', 'cancelled'));

ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS order_status_history_status_check;
ALTER TABLE order_status_history
  ADD CONSTRAINT order_status_history_status_check
  CHECK (status IN ('received', 'preparing', 'oven', 'out_for_delivery', 'completed', 'cancelled'));

DROP TRIGGER IF EXISTS trg_enforce_order_status_transition ON orders;
CREATE TRIGGER trg_enforce_order_status_transition
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION enforce_order_status_transition();

ALTER TABLE order_status_history
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS request_id TEXT;

ALTER TABLE order_status_history DROP CONSTRAINT IF EXISTS order_status_history_source_check;
ALTER TABLE order_status_history
  ADD CONSTRAINT order_status_history_source_check
  CHECK (source IN ('customer_order', 'admin_dashboard', 'customer_cancellation', 'system'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_status_history_request_id
  ON order_status_history (request_id)
  WHERE request_id IS NOT NULL;

-- Record trigger provenance from transaction-local settings.  The backend
-- sets these immediately before its locked status update; customer-created
-- orders remain clearly distinguishable.
CREATE OR REPLACE FUNCTION dashboard_order_event() RETURNS TRIGGER AS $$
DECLARE
  event_source TEXT;
  event_request_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_status_history (order_id, status, source, created_at)
    VALUES (NEW.id, NEW.status, 'customer_order', NEW.created_at);

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
    event_source := NULLIF(current_setting('app.order_status_source', TRUE), '');
    event_request_id := NULLIF(current_setting('app.order_status_request_id', TRUE), '');
    IF event_source IS NULL
       OR event_source NOT IN ('admin_dashboard', 'customer_cancellation', 'system') THEN
      event_source := 'system';
    END IF;

    INSERT INTO order_status_history (order_id, status, source, request_id, created_at)
    VALUES (NEW.id, NEW.status, event_source, event_request_id, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_order_event ON orders;
CREATE TRIGGER trg_dashboard_order_event
AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION dashboard_order_event();

-- The order/customer pair makes it impossible for a queued event to target a
-- phone belonging to a different order owner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND conname = 'orders_id_customer_id_key'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_id_customer_id_key UNIQUE (id, customer_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS customer_notification_events (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('order_status_update', 'cancellation_denied')),
  source TEXT NOT NULL DEFAULT 'admin_dashboard'
    CHECK (source = 'admin_dashboard'),
  order_id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  status_history_id BIGINT UNIQUE
    REFERENCES order_status_history(id) ON DELETE RESTRICT,
  admin_request_id BIGINT
    REFERENCES admin_requests(id) ON DELETE SET NULL,
  order_status TEXT
    CHECK (order_status IS NULL OR order_status IN ('received', 'preparing', 'oven', 'out_for_delivery', 'completed', 'cancelled')),
  decision TEXT
    CHECK (decision IS NULL OR decision IN ('approved', 'denied')),
  admin_note TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'processing', 'sent', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_message_id TEXT,
  last_error TEXT,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_notification_events_order_customer_fk
    FOREIGN KEY (order_id, customer_id)
    REFERENCES orders(id, customer_id) ON DELETE CASCADE,
  CONSTRAINT customer_notification_events_payload_check CHECK (
    (event_type = 'order_status_update' AND order_status IS NOT NULL)
    OR (event_type = 'cancellation_denied' AND decision = 'denied')
  )
);

CREATE INDEX IF NOT EXISTS idx_customer_notification_events_delivery
  ON customer_notification_events (delivery_status, claimed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_customer_notification_events_order
  ON customer_notification_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_notification_events_request
  ON customer_notification_events (admin_request_id, created_at DESC)
  WHERE admin_request_id IS NOT NULL;

-- Notification failures belong on the dashboard, never in an admin WhatsApp
-- fallback.  Request decisions reuse the existing source key so there is one
-- failure record instead of two competing notification systems.
CREATE OR REPLACE FUNCTION dashboard_customer_notification_event() RETURNS TRIGGER AS $$
DECLARE
  failure_source_key TEXT;
BEGIN
  failure_source_key := CASE
    WHEN NEW.admin_request_id IS NOT NULL
      THEN 'request-notification-failed:' || NEW.admin_request_id
    ELSE 'customer-event-failed:' || NEW.id
  END;

  IF NEW.delivery_status = 'failed' THEN
    INSERT INTO admin_notifications (
      notification_type, title, message, source_key,
      order_id, request_id, customer_id, created_at
    ) VALUES (
      'notification_failure',
      'Customer notification failed',
      'Order #' || NEW.order_id || ' customer update could not be delivered. Retry from the dashboard.',
      failure_source_key,
      NEW.order_id,
      NEW.admin_request_id,
      NEW.customer_id,
      NOW()
    ) ON CONFLICT (source_key) DO UPDATE
      SET message = EXCLUDED.message,
          read_at = NULL,
          created_at = NOW();
  ELSIF NEW.delivery_status IN ('sent', 'superseded') THEN
    DELETE FROM admin_notifications WHERE source_key = failure_source_key;
  END IF;

  IF NEW.admin_request_id IS NOT NULL THEN
    IF NEW.delivery_status = 'sent' THEN
      UPDATE admin_requests
      SET notification_sent = TRUE,
          notification_error = NULL,
          notification_attempts = GREATEST(notification_attempts, NEW.attempts),
          last_notification_attempt_at = NEW.updated_at,
          notification_message_id = NEW.provider_message_id,
          notification_claim_token = NULL,
          notification_claimed_at = NULL
      WHERE id = NEW.admin_request_id;
    ELSIF NEW.delivery_status = 'failed' THEN
      UPDATE admin_requests
      SET notification_sent = FALSE,
          notification_error = NEW.last_error,
          notification_attempts = GREATEST(notification_attempts, NEW.attempts),
          last_notification_attempt_at = NEW.updated_at,
          notification_claim_token = NULL,
          notification_claimed_at = NULL
      WHERE id = NEW.admin_request_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_customer_notification_event ON customer_notification_events;
CREATE TRIGGER trg_dashboard_customer_notification_event
AFTER INSERT OR UPDATE OF delivery_status, last_error, provider_message_id, attempts
ON customer_notification_events
FOR EACH ROW EXECUTE FUNCTION dashboard_customer_notification_event();

-- New requests still create the existing dashboard notification.  Delivery
-- failures are now driven solely by customer_notification_events.
CREATE OR REPLACE FUNCTION dashboard_request_event() RETURNS TRIGGER AS $$
BEGIN
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dashboard_request_event ON admin_requests;
CREATE TRIGGER trg_dashboard_request_event
AFTER INSERT ON admin_requests
FOR EACH ROW EXECUTE FUNCTION dashboard_request_event();

COMMIT;
