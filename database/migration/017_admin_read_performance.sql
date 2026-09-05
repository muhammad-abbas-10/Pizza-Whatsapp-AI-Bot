BEGIN;

-- Supports unfiltered recent-order lists and Pakistan-time range queries after
-- those predicates are expressed as direct timestamptz bounds.
CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders (created_at DESC);

-- Supports active/history status filtering while retaining recent-first order.
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
  ON orders (status, created_at DESC);

-- Supports the lightweight activity poll, which detects order status changes
-- without reloading the full orders page.
CREATE INDEX IF NOT EXISTS idx_orders_updated_at
  ON orders (updated_at DESC);

-- Supports the dashboard/activity definition of customers active in 24 hours.
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_updated_at
  ON conversation_sessions (updated_at DESC);

COMMIT;
