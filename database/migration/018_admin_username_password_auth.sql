BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_users_username_length CHECK (char_length(username) BETWEEN 3 AND 64),
  CONSTRAINT admin_users_password_hash_check CHECK (char_length(password_hash) >= 50)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username_lower
  ON admin_users (LOWER(username));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_sessions_token_hash_check CHECK (char_length(token_hash) = 64)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (admin_user_id);

COMMIT;
