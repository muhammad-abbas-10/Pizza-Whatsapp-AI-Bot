-- Structured admin decision requests (e.g. "customer wants to cancel a placed order").
-- Distinct from the general human-handoff flow: this is a single yes/no decision the
-- bot is waiting on, not a full conversation takeover.

CREATE TABLE IF NOT EXISTS admin_requests (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL
        REFERENCES customers(id) ON DELETE CASCADE,
    order_id BIGINT
        REFERENCES orders(id) ON DELETE SET NULL,
    request_type TEXT NOT NULL,        -- e.g. 'cancel_order'
    question TEXT NOT NULL,            -- what the agent is asking admin, in plain language
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied')),
    admin_note TEXT,                   -- optional reason, gets relayed to the customer
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_requests_status
    ON admin_requests (status, created_at);
