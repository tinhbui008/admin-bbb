-- BBB Admin Dashboard - Initial Schema
-- Migration: 001_initial.sql

-- Raw webhook events (store all events for history)
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    event_name VARCHAR(255) NOT NULL,
    meeting_id VARCHAR(255),
    user_id VARCHAR(255),
    user_name VARCHAR(255),
    class_id VARCHAR(255),
    teacher_id VARCHAR(255),
    meeting_name VARCHAR(255),
    role VARCHAR(50),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    checksum_valid BOOLEAN DEFAULT TRUE,
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Classes
CREATE TABLE IF NOT EXISTS classes (
    id SERIAL PRIMARY KEY,
    class_id VARCHAR(255) UNIQUE NOT NULL,
    class_name VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Teachers
CREATE TABLE IF NOT EXISTS teachers (
    id SERIAL PRIMARY KEY,
    teacher_id VARCHAR(255) UNIQUE NOT NULL,
    teacher_name VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Students
CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    user_name VARCHAR(500),
    role VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meetings
CREATE TABLE IF NOT EXISTS meetings (
    id SERIAL PRIMARY KEY,
    meeting_id VARCHAR(255) UNIQUE NOT NULL,
    meeting_name VARCHAR(500),
    class_id VARCHAR(255),
    teacher_id VARCHAR(255),
    created_events INT DEFAULT 0,
    ended_events INT DEFAULT 0,
    join_events INT DEFAULT 0,
    leave_events INT DEFAULT 0,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Class-Teacher relationship (many-to-many)
CREATE TABLE IF NOT EXISTS class_teachers (
    class_id VARCHAR(255) NOT NULL,
    teacher_id VARCHAR(255) NOT NULL,
    PRIMARY KEY (class_id, teacher_id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Class-Student relationship (many-to-many)
CREATE TABLE IF NOT EXISTS class_students (
    class_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    PRIMARY KEY (class_id, user_id),
    join_count INT DEFAULT 0,
    leave_count INT DEFAULT 0,
    last_meeting_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meeting participants (per-meeting activity)
CREATE TABLE IF NOT EXISTS meeting_participants (
    id SERIAL PRIMARY KEY,
    meeting_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    user_name VARCHAR(500),
    role VARCHAR(50),
    join_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    duration_ms BIGINT DEFAULT 0,
    talk_time_ms BIGINT DEFAULT 0,
    webcam_time_ms BIGINT DEFAULT 0,
    messages INT DEFAULT 0,
    reactions INT DEFAULT 0,
    poll_votes INT DEFAULT 0,
    raise_hands INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(meeting_id, user_id)
);

-- Aggregated stats (for dashboard totals)
CREATE TABLE IF NOT EXISTS stats (
    id SERIAL PRIMARY KEY,
    key VARCHAR(50) UNIQUE NOT NULL,
    value BIGINT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook status
CREATE TABLE IF NOT EXISTS webhook_status (
    id SERIAL PRIMARY KEY,
    configured BOOLEAN DEFAULT FALSE,
    callback_url TEXT,
    bbb_api_base_url TEXT,
    registered_hook_id VARCHAR(255),
    get_raw BOOLEAN DEFAULT FALSE,
    event_ids TEXT,
    matching_hook_ids TEXT[],
    last_webhook_received_at TIMESTAMPTZ,
    last_webhook_content_type TEXT,
    last_webhook_preview TEXT,
    last_hook_sync_at TIMESTAMPTZ,
    last_registration_attempt_at TIMESTAMPTZ,
    last_registration_result JSONB,
    last_error TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live rooms (transient, updated periodically)
CREATE TABLE IF NOT EXISTS live_rooms (
    id SERIAL PRIMARY KEY,
    meeting_id VARCHAR(255) UNIQUE NOT NULL,
    meeting_name VARCHAR(500),
    attendee_count INT DEFAULT 0,
    moderator_count INT DEFAULT 0,
    running VARCHAR(10),
    create_time VARCHAR(50),
    class_id VARCHAR(255),
    teacher_id VARCHAR(255),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Events indexes for filtering
CREATE INDEX IF NOT EXISTS idx_events_class_id ON events(class_id);
CREATE INDEX IF NOT EXISTS idx_events_teacher_id ON events(teacher_id);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_meeting_id ON events(meeting_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_event_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);

-- Meetings indexes
CREATE INDEX IF NOT EXISTS idx_meetings_class_id ON meetings(class_id);
CREATE INDEX IF NOT EXISTS idx_meetings_teacher_id ON meetings(teacher_id);
CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);

-- Class students indexes
CREATE INDEX IF NOT EXISTS idx_class_students_user_id ON class_students(user_id);
CREATE INDEX IF NOT EXISTS idx_class_students_class_id ON class_students(class_id);

-- Meeting participants indexes
CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_id ON meeting_participants(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_user_id ON meeting_participants(user_id);

-- ============================================
-- INITIAL DATA
-- ============================================

-- Initialize stats counters
INSERT INTO stats (key, value) VALUES
    ('events', 0),
    ('meetings_created', 0),
    ('meetings_ended', 0),
    ('participants_joined', 0),
    ('participants_left', 0),
    ('checksum_verified', 0),
    ('checksum_rejected', 0)
ON CONFLICT (key) DO NOTHING;

-- Initialize webhook status
INSERT INTO webhook_status (id, configured) VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;
