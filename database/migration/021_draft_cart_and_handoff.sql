BEGIN;

-- Keep cart activity separate from general conversation activity. A normal
-- incoming message updates conversation_sessions.updated_at, so it cannot be
-- used to decide whether a saved draft cart is stale.
ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS cart_updated_at TIMESTAMPTZ;

UPDATE conversation_sessions
SET cart_updated_at = updated_at
WHERE cart_updated_at IS NULL;

ALTER TABLE conversation_sessions
  ALTER COLUMN cart_updated_at SET DEFAULT NOW(),
  ALTER COLUMN cart_updated_at SET NOT NULL;

-- A customer may have only one unresolved human-handoff request at a time.
-- Cancellation requests retain their existing, separate uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_requests_pending_human_handoff
  ON admin_requests (customer_id)
  WHERE request_type = 'human_handoff' AND status = 'pending';

COMMIT;
