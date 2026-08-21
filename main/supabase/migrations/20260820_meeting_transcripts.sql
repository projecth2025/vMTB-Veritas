-- ============================================================================
-- Meeting transcript storage for the bridge-based transcription pipeline.
--
-- These tables are written by:
--   * opus-transcriber-proxy (real-time final transcript segments)
--   * transcript-worker      (status transitions, MoM, artifact object key)
--
-- Identity model (MVP):
--   meeting_id is the JVB transcription session id substituted into Jicofo's
--   `jicofo.transcription.url-template` as {{MEETING_ID}}. It is an opaque
--   TEXT value (Jitsi conference meeting id), NOT meeting_sessions.id and NOT
--   mtb_id. mtb_id is nullable and left NULL for the MVP; populating it is a
--   documented follow-up (Prosody room_metadata transcription.urlParams or a
--   reconciliation step).
--
-- Status values: PENDING -> PROCESSING -> COMPLETED | FAILED
--   PENDING    created when the meeting/session starts (or restarts)
--   PROCESSING claimed atomically by the transcript-worker
--   COMPLETED  final transcript uploaded to GCS + MoM stored
--   FAILED     post-meeting processing failed; error_message holds the reason
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. meeting_transcripts (one row per meeting/session)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_transcripts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id              TEXT NOT NULL UNIQUE,
    mtb_id                  UUID REFERENCES public.mtbs(id) ON DELETE SET NULL,
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
    transcript_object_key   TEXT,
    transcript_version      INTEGER NOT NULL DEFAULT 1,
    mom                     JSONB,
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    error_message           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meeting_transcripts IS
    'High-level metadata for one transcribed meeting. Keyed by the JVB transcription session id.';
COMMENT ON COLUMN public.meeting_transcripts.transcript_object_key IS
    'GCS object name of the canonical transcript, e.g. meetings/<meeting_id>/transcript/transcript-v1.json';
COMMENT ON COLUMN public.meeting_transcripts.mom IS
    'Structured AI Minutes-of-Meeting JSON produced by the transcript-worker LLM step.';

-- ----------------------------------------------------------------------------
-- 2. meeting_transcript_segments (individual real-time transcript segments)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_transcript_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      TEXT NOT NULL REFERENCES public.meeting_transcripts(meeting_id) ON DELETE CASCADE,
    mtb_id          UUID,
    participant_id  TEXT NOT NULL,
    start_time      DOUBLE PRECISION,
    end_time        DOUBLE PRECISION,
    text            TEXT NOT NULL,
    is_final        BOOLEAN NOT NULL DEFAULT TRUE,
    provider        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meeting_transcript_segments IS
    'Real-time transcript segments. Only FINAL segments are persisted; interim results live only in proxy connection memory.';

-- Indexes required by the worker (ordered reconstruction) and by the realtime feed.
CREATE INDEX IF NOT EXISTS idx_meeting_transcript_segments_meeting_id
    ON public.meeting_transcript_segments (meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_transcript_segments_meeting_start
    ON public.meeting_transcript_segments (meeting_id, start_time);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_status
    ON public.meeting_transcripts (status);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_meeting_id
    ON public.meeting_transcripts (meeting_id);

-- ----------------------------------------------------------------------------
-- 3. updated_at triggers
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_meeting_transcripts_updated_at ON public.meeting_transcripts;
CREATE TRIGGER trg_meeting_transcripts_updated_at
    BEFORE UPDATE ON public.meeting_transcripts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_meeting_transcript_segments_updated_at ON public.meeting_transcript_segments;
CREATE TRIGGER trg_meeting_transcript_segments_updated_at
    BEFORE UPDATE ON public.meeting_transcript_segments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ----------------------------------------------------------------------------
-- 4. RPC helpers (single source of truth for status transitions)
-- ----------------------------------------------------------------------------

-- Idempotently ensure a meeting_transcripts row exists (status stays PENDING).
-- Called by opus-transcriber-proxy when a JVB transcription session opens.
CREATE OR REPLACE FUNCTION public.ensure_meeting_transcript(p_meeting_id TEXT)
RETURNS public.meeting_transcripts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.meeting_transcripts;
BEGIN
    INSERT INTO public.meeting_transcripts (meeting_id, status, started_at)
    VALUES (p_meeting_id, 'PENDING', now())
    ON CONFLICT (meeting_id) DO NOTHING
    RETURNING * INTO v_row;

    IF v_row IS NULL THEN
        SELECT * INTO v_row FROM public.meeting_transcripts WHERE meeting_id = p_meeting_id;
    END IF;

    RETURN v_row;
END;
$$;

-- Atomically claim a PENDING row for processing. Returns the claimed row, or
-- NULL if no PENDING row exists (already PROCESSING/COMPLETED/FAILED).
-- This is the worker's idempotency lock: concurrent deliveries cannot both win.
CREATE OR REPLACE FUNCTION public.claim_meeting_transcript(p_meeting_id TEXT)
RETURNS public.meeting_transcripts
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.meeting_transcripts
    SET status = 'PROCESSING',
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PENDING'
    RETURNING *;
$$;

-- Mark a row COMPLETED with the GCS artifact key, version and MoM.
CREATE OR REPLACE FUNCTION public.complete_meeting_transcript(
    p_meeting_id TEXT,
    p_object_key TEXT,
    p_version INTEGER,
    p_mom JSONB
)
RETURNS public.meeting_transcripts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.meeting_transcripts;
BEGIN
    UPDATE public.meeting_transcripts
    SET status = 'COMPLETED',
        transcript_object_key = p_object_key,
        transcript_version = p_version,
        mom = p_mom,
        completed_at = now(),
        error_message = NULL,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PROCESSING'
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- Mark a row FAILED (post-meeting processing error). Idempotent guard: only a
-- PROCESSING row can be failed, so a stale/re-delivered failure cannot corrupt
-- an already COMPLETED meeting.
CREATE OR REPLACE FUNCTION public.fail_meeting_transcript(
    p_meeting_id TEXT,
    p_error_message TEXT
)
RETURNS public.meeting_transcripts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.meeting_transcripts;
BEGIN
    UPDATE public.meeting_transcripts
    SET status = 'FAILED',
        error_message = p_error_message,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PROCESSING'
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Row Level Security
-- ----------------------------------------------------------------------------
-- service_role (used by the proxy and the worker) bypasses RLS by default.

ALTER TABLE public.meeting_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_transcript_segments ENABLE ROW LEVEL SECURITY;

-- Members of an MTB can read transcripts/MoMs and segments for their MTBs.
-- (mtb_id is NULL for MVP meetings, so members cannot yet read those rows; this
-- policy is the correct one once mtb_id is populated.)
DROP POLICY IF EXISTS "Members can view meeting transcripts for their MTBs"
    ON public.meeting_transcripts;
CREATE POLICY "Members can view meeting transcripts for their MTBs"
    ON public.meeting_transcripts
    FOR SELECT
    USING (
        mtb_id IS NOT NULL
        AND mtb_id IN (
            SELECT mtb_id FROM public.mtb_members WHERE user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Members can view transcript segments for their MTBs"
    ON public.meeting_transcript_segments;
CREATE POLICY "Members can view transcript segments for their MTBs"
    ON public.meeting_transcript_segments
    FOR SELECT
    USING (
        mtb_id IS NOT NULL
        AND mtb_id IN (
            SELECT mtb_id FROM public.mtb_members WHERE user_id = auth.uid()
        )
    );

-- ----------------------------------------------------------------------------
-- 6. Realtime (optional; enables live transcript display in the frontend)
-- ----------------------------------------------------------------------------
-- Idempotent: adding a table to the publication a second time is a no-op.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'meeting_transcript_segments'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.meeting_transcript_segments;
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 7. Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_transcripts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_transcript_segments TO service_role;
GRANT SELECT ON public.meeting_transcripts TO anon, authenticated;
GRANT SELECT ON public.meeting_transcript_segments TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_meeting_transcript(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_meeting_transcript(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT) TO service_role;