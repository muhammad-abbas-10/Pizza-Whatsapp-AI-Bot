BEGIN;

-- Durable, idempotent customer-message acceptance and turn batching.
ALTER TABLE message_buffer
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS message_type TEXT,
  ADD COLUMN IF NOT EXISTS batch_key TEXT,
  ADD COLUMN IF NOT EXISTS batch_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_buffer_message_id
  ON message_buffer (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_buffer_turn_queue
  ON message_buffer (customer_phone, processed, batch_claimed_at, id)
  WHERE processed = FALSE AND message_id IS NOT NULL;

-- Rows created by the old workflow do not contain Meta message ids and cannot
-- be safely deduplicated or replayed. Keep them for audit, but remove them from
-- the active queue so a future customer message cannot replay an old backlog.
UPDATE message_buffer
SET processed = TRUE,
    processed_at = COALESCE(processed_at, NOW())
WHERE processed = FALSE
  AND message_id IS NULL;

-- Admin messages bypass the customer/session path but still need a durable
-- lease so duplicate Meta webhook deliveries cannot resolve a request twice.
CREATE TABLE IF NOT EXISTS admin_message_claims (
  message_id TEXT PRIMARY KEY,
  admin_phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'processed')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_message_claims_status
  ON admin_message_claims (status, claimed_at);

-- Resolution provenance makes WhatsApp and dashboard decisions auditable and
-- gives the workflow a stable idempotency key for repeat commands.
ALTER TABLE admin_requests
  ADD COLUMN IF NOT EXISTS resolved_by_phone TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by_message_id TEXT,
  ADD COLUMN IF NOT EXISTS notification_claim_token TEXT,
  ADD COLUMN IF NOT EXISTS notification_claimed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_requests_resolved_by_message
  ON admin_requests (resolved_by_message_id)
  WHERE resolved_by_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_requests_notification_claim
  ON admin_requests (notification_claimed_at)
  WHERE notification_sent = FALSE AND notification_claim_token IS NOT NULL;

COMMIT;
