BEGIN;

-- Durable outbound reply state closes the crash window between WhatsApp send
-- success and final message-buffer processing.
ALTER TABLE message_buffer
  ADD COLUMN IF NOT EXISTS reply_text TEXT,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_message_buffer_reply_recovery
  ON message_buffer (customer_phone, processed, replied_at, batch_claimed_at)
  WHERE processed = FALSE AND replied_at IS NOT NULL;

COMMIT;
