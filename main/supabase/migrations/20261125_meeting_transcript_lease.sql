-- ============================================================================
-- Lease + attempt counter for meeting_transcripts (issue #69, part 1).
--
-- Before this migration a worker that died between claim and complete/fail
-- left the row in PROCESSING forever: claim only accepted PENDING, so every
-- Pub/Sub redelivery got "no row" back, was acked as "already processed", and
-- the minutes were never produced.
--
-- Now:
--   * claim accepts PENDING, or PROCESSING whose lease (claimed_at) expired.
--   * each claim bumps `attempts` and stamps a fresh `claimed_at`.
--   * after MAX attempts the row is marked FAILED instead of retrying forever.
--   * complete/fail require the claim token (claimed_at) they were handed, so
--     a worker presumed dead cannot overwrite a newer attempt's result.
--
-- Lease size: the worker's worst case is the 600s Cloud Run request timeout,
-- so 10 minutes clears it with headroom.
-- ============================================================================

ALTER TABLE public.meeting_transcripts
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.meeting_transcripts.claimed_at IS
    'Lease start of the current PROCESSING claim; NULL unless PROCESSING. Expired lease = reclaimable.';
COMMENT ON COLUMN public.meeting_transcripts.attempts IS
    'How many times this row has been claimed; capped, after which it is FAILED.';

-- How long one claim is considered live before another delivery may take over.
CREATE OR REPLACE FUNCTION public.meeting_transcript_lease_seconds()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 600 $$;

-- How many claims are allowed before the row is failed permanently.
CREATE OR REPLACE FUNCTION public.meeting_transcript_max_attempts()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT 3 $$;

-- ----------------------------------------------------------------------------
-- claim: PENDING, or PROCESSING with an expired lease.
-- Returns NULL for a terminal row (COMPLETED/FAILED) or a live lease held by
-- an in-flight worker.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_meeting_transcript(p_meeting_id TEXT)
RETURNS public.meeting_transcripts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.meeting_transcripts;
BEGIN
    UPDATE public.meeting_transcripts
    SET status = 'PROCESSING',
        claimed_at = now(),
        attempts = attempts + 1,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND attempts < public.meeting_transcript_max_attempts()
      AND (
            status = 'PENDING'
         OR (status = 'PROCESSING'
             AND (claimed_at IS NULL
                  OR claimed_at < now() - make_interval(secs => public.meeting_transcript_lease_seconds())))
      )
    RETURNING * INTO v_row;

    IF v_row IS NOT NULL THEN
        RETURN v_row;
    END IF;

    -- Out of attempts and still stuck: fail permanently rather than spin.
    UPDATE public.meeting_transcripts
    SET status = 'FAILED',
        error_message = COALESCE(
            error_message,
            'transcript processing abandoned after ' || public.meeting_transcript_max_attempts() || ' attempts'
        ),
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PROCESSING'
      AND attempts >= public.meeting_transcript_max_attempts()
      AND (claimed_at IS NULL
           OR claimed_at < now() - make_interval(secs => public.meeting_transcript_lease_seconds()))
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- ----------------------------------------------------------------------------
-- complete: PROCESSING + matching claim token only.
-- (The extra parameter changes the signature, so drop the old overload first.)
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB);
CREATE FUNCTION public.complete_meeting_transcript(
    p_meeting_id TEXT,
    p_object_key TEXT,
    p_version INTEGER,
    p_mom JSONB,
    p_claimed_at TIMESTAMPTZ DEFAULT NULL
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
        claimed_at = NULL,
        error_message = NULL,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PROCESSING'
      AND (p_claimed_at IS NULL OR claimed_at = p_claimed_at)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- ----------------------------------------------------------------------------
-- fail: PROCESSING + matching claim token only.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fail_meeting_transcript(TEXT, TEXT);
CREATE FUNCTION public.fail_meeting_transcript(
    p_meeting_id TEXT,
    p_error_message TEXT,
    p_claimed_at TIMESTAMPTZ DEFAULT NULL
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
        claimed_at = NULL,
        updated_at = now()
    WHERE meeting_id = p_meeting_id
      AND status = 'PROCESSING'
      AND (p_claimed_at IS NULL OR claimed_at = p_claimed_at)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- ----------------------------------------------------------------------------
-- Grants (mirrors 20261003_revoke_public_execute_grants.sql: service_role only)
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_meeting_transcript(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meeting_transcript_lease_seconds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meeting_transcript_max_attempts() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.claim_meeting_transcript(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_meeting_transcript(TEXT, TEXT, INTEGER, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_meeting_transcript(TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.meeting_transcript_lease_seconds() TO service_role;
GRANT EXECUTE ON FUNCTION public.meeting_transcript_max_attempts() TO service_role;
