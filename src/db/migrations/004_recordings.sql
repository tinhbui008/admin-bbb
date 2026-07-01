-- BBB session recordings synced from the getRecordings API.
-- Refreshed on each syncDashboardState run; keyed by BBB recordID.

CREATE TABLE IF NOT EXISTS recordings (
  record_id     TEXT PRIMARY KEY,
  meeting_id    TEXT,
  class_id      TEXT,
  name          TEXT,
  state         TEXT,
  published     BOOLEAN,
  start_time    BIGINT,
  end_time      BIGINT,
  duration_ms   BIGINT,
  participants  INTEGER,
  playback      JSONB DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recordings_class_id ON recordings(class_id);
CREATE INDEX IF NOT EXISTS idx_recordings_meeting_id ON recordings(meeting_id);
