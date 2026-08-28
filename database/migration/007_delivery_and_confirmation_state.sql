BEGIN;

ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS awaiting_delivery_info BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_name TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_name TEXT;

COMMIT;
