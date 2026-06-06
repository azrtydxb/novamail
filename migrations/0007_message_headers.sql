-- Capture a few parsed headers for the tracing UI (subject/message-id) and the
-- message size, recorded by ingress at submission.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS subject    text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS size_bytes bigint;
