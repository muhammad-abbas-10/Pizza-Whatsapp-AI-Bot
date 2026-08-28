
ALTER TABLE conversation_sessions
ADD COLUMN awaiting_human BOOLEAN NOT NULL DEFAULT false;