BEGIN;

-- Address clarification is another authenticated dashboard-to-customer event.
-- It deliberately reuses the existing durable notification outbox so the
-- browser never receives a WhatsApp number, token, or n8n webhook URL.
ALTER TABLE customer_notification_events
  DROP CONSTRAINT IF EXISTS customer_notification_events_event_type_check;
ALTER TABLE customer_notification_events
  ADD CONSTRAINT customer_notification_events_event_type_check
  CHECK (event_type IN (
    'order_status_update',
    'cancellation_denied',
    'admin_address_clarification'
  ));

ALTER TABLE customer_notification_events
  DROP CONSTRAINT IF EXISTS customer_notification_events_payload_check;
ALTER TABLE customer_notification_events
  ADD CONSTRAINT customer_notification_events_payload_check CHECK (
    (event_type = 'order_status_update' AND order_status IS NOT NULL)
    OR (event_type = 'cancellation_denied' AND decision = 'denied')
    OR (
      event_type = 'admin_address_clarification'
      AND NULLIF(BTRIM(admin_note), '') IS NOT NULL
      AND order_status IS NULL
      AND decision IS NULL
    )
  );

-- Only one clarification may be queued/in-flight for an order. A later
-- clarification remains possible after the previous one is sent or fails.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_events_one_active_address_clarification
  ON customer_notification_events (order_id)
  WHERE event_type = 'admin_address_clarification'
    AND delivery_status IN ('pending', 'processing');

COMMIT;
