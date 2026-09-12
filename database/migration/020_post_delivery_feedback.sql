BEGIN;

-- Reuse the dashboard's existing feedback table while allowing either a
-- rating, a written comment, or both. Ratings are normalized before insert.
ALTER TABLE feedback
  ALTER COLUMN rating DROP NOT NULL;

ALTER TABLE feedback
  DROP CONSTRAINT IF EXISTS feedback_rating_check;

ALTER TABLE feedback
  ADD CONSTRAINT feedback_rating_check
  CHECK (rating IS NULL OR rating BETWEEN 0 AND 5);

ALTER TABLE feedback
  DROP CONSTRAINT IF EXISTS feedback_has_content_check;

ALTER TABLE feedback
  ADD CONSTRAINT feedback_has_content_check
  CHECK (rating IS NOT NULL OR NULLIF(BTRIM(message), '') IS NOT NULL);

-- A completed order owns at most one feedback record. Replayed customer turns
-- update this same row through the workflow's upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_order_once
  ON feedback (order_id)
  WHERE order_id IS NOT NULL;

-- The existing session remains the single source of conversation state.
ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS awaiting_feedback_order_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'conversation_sessions'::regclass
      AND conname = 'conversation_sessions_awaiting_feedback_order_fk'
  ) THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_awaiting_feedback_order_fk
      FOREIGN KEY (awaiting_feedback_order_id)
      REFERENCES orders(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

-- This durable marker makes the feedback request one-time per completed order,
-- independently of retries of the surrounding dashboard notification event.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS feedback_requested_at TIMESTAMPTZ;

COMMIT;
