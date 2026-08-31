BEGIN;

ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS recent_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pending_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS order_status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS active_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS message_buffer (
  id BIGSERIAL PRIMARY KEY,
  customer_phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_message_buffer_pending
  ON message_buffer (customer_phone, processed, id);

CREATE TABLE IF NOT EXISTS menu_images (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL
    CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
  image_data BYTEA NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_requests
  ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notification_error TEXT;

COMMIT;
