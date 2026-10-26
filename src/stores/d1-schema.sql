CREATE TABLE IF NOT EXISTS mailswitch_idempotency (
  key TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'not_sent', 'unknown')),
  claim_id TEXT NOT NULL,
  attempts TEXT NOT NULL DEFAULT '[]',
  provider_message_id TEXT,
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS mailswitch_idempotency_expires_at ON mailswitch_idempotency (expires_at);
