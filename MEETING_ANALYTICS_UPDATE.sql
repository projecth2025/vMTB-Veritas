-- ============================================
-- Meeting Analytics Schema UPDATE - Heartbeat Column
-- ============================================
-- Run this SQL in your Supabase SQL Editor AFTER the initial schema
-- This adds the last_heartbeat column for stale meeting detection

-- Add last_heartbeat column to meeting_sessions
ALTER TABLE meeting_sessions 
ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ DEFAULT NOW();

-- Create index for efficient queries that filter by heartbeat
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_heartbeat 
    ON meeting_sessions(last_heartbeat) 
    WHERE status = 'active';

-- ============================================
-- HOW IT WORKS
-- ============================================
-- 
-- 1. When a meeting starts, last_heartbeat = NOW()
-- 2. While meeting is active, heartbeat updates every 30 seconds
-- 3. When user leaves normally → status = 'ended'
-- 4. When user closes tab → heartbeat stops, session stays 'active' but STALE
-- 
-- IMPORTANT: Frontend does NOT close stale meetings!
-- Instead, when checking for active sessions, the query filters:
--   WHERE status = 'active' AND last_heartbeat > NOW() - INTERVAL '2 minutes'
-- 
-- Stale sessions are simply IGNORED, not modified.
-- This ensures new meetings can always be created.

-- ============================================
-- OPTIONAL: Backend cleanup function
-- Run periodically via cron to clean up old stale sessions
-- This is for data hygiene only, not required for functionality
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_stale_meetings_backend()
RETURNS INTEGER AS $$
DECLARE
    closed_count INTEGER;
BEGIN
    -- Close meetings that have been stale for more than 1 hour
    -- (giving plenty of buffer beyond the 2-minute threshold)
    WITH stale AS (
        UPDATE meeting_sessions
        SET 
            status = 'ended',
            ended_at = last_heartbeat,
            total_duration_seconds = EXTRACT(EPOCH FROM (last_heartbeat - started_at))::INTEGER
        WHERE 
            status = 'active' 
            AND last_heartbeat < NOW() - INTERVAL '1 hour'
        RETURNING id
    )
    SELECT COUNT(*) INTO closed_count FROM stale;
    
    -- Also close orphaned participants
    UPDATE meeting_participants mp
    SET 
        left_at = COALESCE(mp.left_at, ms.last_heartbeat),
        duration_seconds = EXTRACT(EPOCH FROM (COALESCE(mp.left_at, ms.last_heartbeat) - mp.joined_at))::INTEGER,
        left_reason = COALESCE(mp.left_reason, 'stale_cleanup')
    FROM meeting_sessions ms
    WHERE 
        mp.meeting_session_id = ms.id
        AND mp.left_at IS NULL
        AND ms.status = 'ended';
    
    RETURN closed_count;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION cleanup_stale_meetings_backend() TO service_role;

-- ============================================
-- OPTIONAL: Set up cron job (requires pg_cron extension)
-- ============================================
-- SELECT cron.schedule(
--     'cleanup-stale-meetings',
--     '0 * * * *',  -- Every hour
--     $$SELECT cleanup_stale_meetings_backend()$$
-- );
