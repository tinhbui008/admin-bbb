-- Prevent duplicate event insertion by hashing the raw payload.
-- If BBB sends the same webhook twice, the second insert is silently discarded.

ALTER TABLE events ADD COLUMN IF NOT EXISTS raw_payload_hash VARCHAR(32);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_payload_hash
ON events(raw_payload_hash)
WHERE raw_payload_hash IS NOT NULL;
