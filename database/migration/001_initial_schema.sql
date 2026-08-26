BEGIN;

CREATE TABLE IF NOT EXISTS customers (
    id BIGSERIAL PRIMARY KEY,
    whatsapp_phone TEXT UNIQUE NOT NULL,
    name TEXT,
    preferred_language TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT UNIQUE NOT NULL
        REFERENCES customers(id) ON DELETE CASCADE,
    cart JSONB NOT NULL DEFAULT '{"items":[]}'::jsonb,
    order_type TEXT
        CHECK (order_type IN ('delivery', 'pickup')),
    delivery_address TEXT,
    awaiting_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
    human_handoff BOOLEAN NOT NULL DEFAULT FALSE,
    last_question TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_phone
    ON processed_messages(customer_phone);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_customer
    ON conversation_sessions(customer_id);

COMMIT;