-- Replace the partial unique index with a regular unique index so that
-- ON CONFLICT (raw_payload_hash) DO NOTHING resolves without a WHERE predicate.
-- PostgreSQL partial index requires ON CONFLICT ... WHERE <predicate> to match,
-- but a regular unique index works with the simpler ON CONFLICT (column) form.

DROP INDEX IF EXISTS idx_events_payload_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_payload_hash
ON events(raw_payload_hash);
