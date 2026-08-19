-- ============================================
-- Meeting Analytics Schema for VMTB
-- ============================================
-- Run this SQL in your Supabase SQL Editor
-- This creates the tables needed for meeting analytics tracking

-- ============================================
-- 1. Meeting Sessions Table
-- Stores one row per meeting session
-- ============================================
CREATE TABLE IF NOT EXISTS meeting_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mtb_id UUID NOT NULL REFERENCES mtbs(id) ON DELETE CASCADE,
    room_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    total_duration_seconds INTEGER,
    max_participants INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups by room name and status (to check for active meetings)
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_room_status 
    ON meeting_sessions(room_name, status);

-- Index for MTB analytics queries
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_mtb_id 
    ON meeting_sessions(mtb_id);

-- Index for date range queries
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_started_at 
    ON meeting_sessions(started_at);

-- ============================================
-- 2. Meeting Participants Table
-- Stores one row per participant join event
-- (same person rejoining = new row)
-- ============================================
CREATE TABLE IF NOT EXISTS meeting_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_session_id UUID NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL, -- Jitsi participant ID (anonymous identifier)
    display_name TEXT, -- Display name if available
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    left_reason TEXT, -- 'normal', 'tab_closed', 'disconnected', 'unknown'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for session participant lookups
CREATE INDEX IF NOT EXISTS idx_meeting_participants_session_id 
    ON meeting_participants(meeting_session_id);

-- Index for finding active participants
CREATE INDEX IF NOT EXISTS idx_meeting_participants_session_left 
    ON meeting_participants(meeting_session_id, left_at);

-- ============================================
-- 3. Enable Row Level Security (RLS)
-- ============================================
ALTER TABLE meeting_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 4. RLS Policies for meeting_sessions
-- ============================================

-- Allow authenticated users to view meeting sessions for MTBs they belong to
CREATE POLICY "Users can view meeting sessions for their MTBs"
    ON meeting_sessions FOR SELECT
    USING (
        mtb_id IN (
            SELECT mtb_id FROM mtb_members WHERE user_id = auth.uid()
        )
    );

-- Allow service role and anon key to insert/update meeting sessions
-- (needed for the Jitsi frontend which uses anon key)
CREATE POLICY "Service can insert meeting sessions"
    ON meeting_sessions FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Service can update meeting sessions"
    ON meeting_sessions FOR UPDATE
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 5. RLS Policies for meeting_participants
-- ============================================

-- Allow authenticated users to view participants for their MTB meetings
CREATE POLICY "Users can view meeting participants for their MTBs"
    ON meeting_participants FOR SELECT
    USING (
        meeting_session_id IN (
            SELECT ms.id FROM meeting_sessions ms
            JOIN mtb_members mm ON ms.mtb_id = mm.mtb_id
            WHERE mm.user_id = auth.uid()
        )
    );

-- Allow service role and anon key to insert/update participants
CREATE POLICY "Service can insert meeting participants"
    ON meeting_participants FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Service can update meeting participants"
    ON meeting_participants FOR UPDATE
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 6. Helper Functions
-- ============================================

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for meeting_sessions
DROP TRIGGER IF EXISTS update_meeting_sessions_updated_at ON meeting_sessions;
CREATE TRIGGER update_meeting_sessions_updated_at
    BEFORE UPDATE ON meeting_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for meeting_participants
DROP TRIGGER IF EXISTS update_meeting_participants_updated_at ON meeting_participants;
CREATE TRIGGER update_meeting_participants_updated_at
    BEFORE UPDATE ON meeting_participants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 7. Analytics Views (Optional but useful)
-- ============================================

-- View for MTB meeting statistics
CREATE OR REPLACE VIEW mtb_meeting_stats AS
SELECT 
    mtb_id,
    COUNT(*) AS total_meetings,
    COUNT(CASE WHEN status = 'ended' THEN 1 END) AS completed_meetings,
    ROUND(AVG(total_duration_seconds)::numeric, 0) AS avg_duration_seconds,
    SUM(total_duration_seconds) AS total_time_seconds,
    ROUND(AVG(max_participants)::numeric, 1) AS avg_participants,
    MAX(max_participants) AS peak_participants,
    MIN(started_at) AS first_meeting_at,
    MAX(started_at) AS last_meeting_at
FROM meeting_sessions
WHERE status = 'ended'
GROUP BY mtb_id;

-- ============================================
-- 8. Sample Queries for Analytics
-- ============================================
/*
-- Get all meetings for an MTB
SELECT * FROM meeting_sessions 
WHERE mtb_id = 'your-mtb-id' 
ORDER BY started_at DESC;

-- Get meeting statistics for an MTB
SELECT * FROM mtb_meeting_stats WHERE mtb_id = 'your-mtb-id';

-- Get participant details for a specific meeting
SELECT * FROM meeting_participants 
WHERE meeting_session_id = 'your-session-id' 
ORDER BY joined_at;

-- Get total time spent in meetings across all MTBs
SELECT 
    SUM(total_duration_seconds) / 3600 AS total_hours,
    COUNT(*) AS total_meetings
FROM meeting_sessions WHERE status = 'ended';

-- Get most active MTBs by meeting count
SELECT 
    m.name AS mtb_name,
    ms.total_meetings,
    ms.avg_duration_seconds / 60 AS avg_duration_minutes,
    ms.avg_participants
FROM mtb_meeting_stats ms
JOIN mtbs m ON m.id = ms.mtb_id
ORDER BY ms.total_meetings DESC
LIMIT 10;
*/
