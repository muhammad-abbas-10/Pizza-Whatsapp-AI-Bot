BEGIN;

ALTER TABLE admin_requests
  ADD COLUMN IF NOT EXISTS notification_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_notification_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_message_id TEXT;

-- A permanent CHECK would conflict with the existing ON DELETE SET NULL
-- foreign key. Validation is therefore performed by the trigger below.
ALTER TABLE admin_requests
  DROP CONSTRAINT IF EXISTS admin_requests_cancel_order_requires_order;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_requests_one_pending_cancel_per_order
  ON admin_requests (order_id)
  WHERE request_type = 'cancel_order' AND status = 'pending';

CREATE OR REPLACE FUNCTION validate_admin_request_order_owner() RETURNS TRIGGER AS $$
DECLARE
  linked_customer_id BIGINT;
BEGIN
  IF NEW.request_type = 'cancel_order'
    AND NEW.order_id IS NULL
    AND (TG_OP = 'INSERT' OR NEW.status = 'pending') THEN
    RAISE EXCEPTION 'A pending cancellation request must reference an order';
  END IF;
  IF NEW.order_id IS NOT NULL THEN
    SELECT customer_id INTO linked_customer_id FROM orders WHERE id = NEW.order_id;
    IF linked_customer_id IS NULL THEN
      RAISE EXCEPTION 'Admin request order % does not exist', NEW.order_id;
    END IF;
    IF linked_customer_id <> NEW.customer_id THEN
      RAISE EXCEPTION 'Admin request order does not belong to its customer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_admin_request_order_owner ON admin_requests;
CREATE TRIGGER trg_validate_admin_request_order_owner
BEFORE INSERT OR UPDATE OF customer_id, order_id, status ON admin_requests
FOR EACH ROW EXECUTE FUNCTION validate_admin_request_order_owner();

COMMIT;
