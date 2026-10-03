BEGIN;

-- A handoff needs durable, directional messages.  message_buffer remains the
-- inbound-work queue; this table is the auditable conversation visible to staff.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  handoff_request_id BIGINT NOT NULL REFERENCES admin_requests(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('customer', 'bot', 'staff')),
  message_text TEXT NOT NULL CHECK (char_length(BTRIM(message_text)) BETWEEN 1 AND 2000),
  source_message_id TEXT UNIQUE,
  client_message_id TEXT UNIQUE,
  staff_admin_user_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
  delivery_status TEXT NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received', 'pending', 'processing', 'sent', 'failed')),
  provider_message_id TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversation_messages_direction_delivery_check CHECK (
    (direction = 'customer' AND delivery_status = 'received')
    OR (direction = 'bot' AND delivery_status = 'sent')
    OR direction = 'staff'
  )
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_handoff
  ON conversation_messages (handoff_request_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_customer
  ON conversation_messages (customer_id, created_at DESC);

-- Preserve the existing request status vocabulary. A pending human_handoff is
-- the active staff conversation; the first staff message identifies who took it.
ALTER TABLE admin_requests
  ADD COLUMN IF NOT EXISTS human_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_started_by_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS human_ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_ended_by_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE SET NULL;

-- Reuse the durable customer-notification outbox for an authenticated staff
-- reply. Staff replies deliberately do not need or mutate an order.
ALTER TABLE customer_notification_events
  ADD COLUMN IF NOT EXISTS conversation_message_id BIGINT
    REFERENCES conversation_messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE customer_notification_events
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE customer_notification_events
  DROP CONSTRAINT IF EXISTS customer_notification_events_event_type_check,
  DROP CONSTRAINT IF EXISTS customer_notification_events_payload_check;

ALTER TABLE customer_notification_events
  ADD CONSTRAINT customer_notification_events_event_type_check
    CHECK (event_type IN ('order_status_update', 'cancellation_denied', 'staff_message')),
  ADD CONSTRAINT customer_notification_events_payload_check CHECK (
    (event_type = 'order_status_update' AND order_id IS NOT NULL AND order_status IS NOT NULL)
    OR (event_type = 'cancellation_denied' AND order_id IS NOT NULL AND decision = 'denied')
    OR (event_type = 'staff_message'
        AND order_id IS NULL
        AND conversation_message_id IS NOT NULL
        AND admin_user_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_notification_events_conversation_message
  ON customer_notification_events (conversation_message_id)
  WHERE conversation_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_handoff_message_delivery() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type = 'staff_message' AND NEW.conversation_message_id IS NOT NULL THEN
    UPDATE conversation_messages
    SET delivery_status = CASE
          WHEN NEW.delivery_status IN ('pending', 'processing', 'sent', 'failed') THEN NEW.delivery_status
          ELSE delivery_status
        END,
        provider_message_id = CASE
          WHEN NEW.delivery_status = 'sent' THEN NEW.provider_message_id
          ELSE provider_message_id
        END,
        last_error = CASE
          WHEN NEW.delivery_status = 'failed' THEN NEW.last_error
          WHEN NEW.delivery_status = 'sent' THEN NULL
          ELSE last_error
        END,
        sent_at = CASE WHEN NEW.delivery_status = 'sent' THEN NEW.sent_at ELSE sent_at END
    WHERE id = NEW.conversation_message_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_handoff_message_delivery ON customer_notification_events;
CREATE TRIGGER trg_sync_handoff_message_delivery
AFTER INSERT OR UPDATE OF delivery_status, provider_message_id, last_error, sent_at
ON customer_notification_events
FOR EACH ROW EXECUTE FUNCTION sync_handoff_message_delivery();

-- Keep existing notification behavior for order events and add a useful,
-- retryable dashboard alert when a real staff WhatsApp reply fails.
CREATE OR REPLACE FUNCTION dashboard_customer_notification_event() RETURNS TRIGGER AS $$
DECLARE
  failure_source_key TEXT;
BEGIN
  IF NEW.event_type = 'staff_message' THEN
    failure_source_key := 'handoff-message-failed:' || NEW.conversation_message_id;
    IF NEW.delivery_status = 'failed' THEN
      INSERT INTO admin_notifications (
        notification_type, title, message, source_key, request_id, customer_id, created_at
      ) VALUES (
        'notification_failure',
        'Staff WhatsApp message failed',
        'A staff reply to a customer could not be delivered. Retry it from the handoff conversation.',
        failure_source_key,
        (SELECT handoff_request_id FROM conversation_messages WHERE id = NEW.conversation_message_id),
        NEW.customer_id,
        NOW()
      ) ON CONFLICT (source_key) DO UPDATE
        SET message = EXCLUDED.message, read_at = NULL, created_at = NOW();
    ELSIF NEW.delivery_status = 'sent' THEN
      DELETE FROM admin_notifications WHERE source_key = failure_source_key;
    END IF;
    RETURN NEW;
  END IF;

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

COMMIT;
