-- Scenario tests for 20261125_meeting_transcript_lease.sql (lease, attempts,
-- claim token). The migration and this block run inside one transaction, and
-- the block ends by raising TEST_RESULTS <json>, which aborts it: seeing
-- "ERROR: TEST_RESULTS {...}" with all of T1-T7 is a PASS; any other error is
-- a failed assertion.
--
-- Run it against a THROWAWAY local Postgres, never the linked production
-- project: the script runs DDL (ALTER TABLE, DROP FUNCTION) that locks a live
-- table even though it rolls back. From main/supabase/:
--
--   docker run -d --rm --name lease-test -e POSTGRES_PASSWORD=x \
--     public.ecr.aws/supabase/postgres:17.6.1.156
--   P="docker exec -i lease-test psql -U postgres -h localhost -v ON_ERROR_STOP=1 -q"
--   # stubs for what 20260820_meeting_transcripts.sql references:
--   $P -c "CREATE TABLE public.mtbs (id uuid PRIMARY KEY);
--          CREATE TABLE public.mtb_members (mtb_id uuid, user_id uuid);
--          CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
--            LANGUAGE plpgsql AS \$\$BEGIN NEW.updated_at = now(); RETURN NEW; END\$\$;"
--   $P < migrations/20260820_meeting_transcripts.sql
--   { echo "BEGIN;"; cat migrations/20261125_meeting_transcript_lease.sql \
--       tests/meeting_transcript_lease_test.sql; echo "ROLLBACK;"; } | $P
--   docker stop lease-test
--
-- The point of the whole change: a worker that dies between claim and
-- complete/fail must not leave the row in PROCESSING forever. Every claim
-- below either reclaims an expired lease, refuses a live one, or gives up
-- after the attempt cap.
DO $test$
DECLARE
    res jsonb := '{}'::jsonb;
    r public.meeting_transcripts;
    mid1 text := 'lease-test-terminal';
    mid2 text := 'lease-test-reclaim';
    mid3 text := 'lease-test-live';
    mid4 text := 'lease-test-exhausted';
    tok timestamptz;
BEGIN
    -- T1 fresh claim from PENDING: stamps a token, attempts 0 -> 1.
    INSERT INTO public.meeting_transcripts (meeting_id, status) VALUES (mid1, 'PENDING');
    r := public.claim_meeting_transcript(mid1);
    ASSERT r.status = 'PROCESSING', format('T1 status=%s', r.status);
    ASSERT r.attempts = 1, format('T1 attempts=%s', r.attempts);
    ASSERT r.claimed_at IS NOT NULL, 'T1 claim token missing';
    tok := r.claimed_at;
    res := res || jsonb_build_object('T1', jsonb_build_object('status', r.status, 'attempts', r.attempts));

    -- T2 a stale claim token must NOT complete the row.
    r := public.complete_meeting_transcript(mid1, 'k1', 1, 'null'::jsonb, tok - interval '1 second');
    ASSERT r IS NULL, format('T2 stale token completed: %s', r.status);
    ASSERT (SELECT status FROM public.meeting_transcripts WHERE meeting_id = mid1) = 'PROCESSING',
        'T2 row moved despite stale token';
    res := res || jsonb_build_object('T2', 'stale token refused');

    -- T3 the right token completes it and releases the lease.
    r := public.complete_meeting_transcript(mid1, 'k1', 1, 'null'::jsonb, tok);
    ASSERT r.status = 'COMPLETED', format('T3 status=%s', r.status);
    ASSERT r.claimed_at IS NULL, 'T3 lease not released';
    res := res || jsonb_build_object('T3', jsonb_build_object('status', r.status, 'lease_released', r.claimed_at IS NULL));

    -- T4 a terminal row is never claimable again.
    r := public.claim_meeting_transcript(mid1);
    ASSERT r IS NULL, format('T4 claimed a COMPLETED row: %s', r.status);
    ASSERT (SELECT status FROM public.meeting_transcripts WHERE meeting_id = mid1) = 'COMPLETED', 'T4 status changed';
    res := res || jsonb_build_object('T4', 'terminal row not claimable');

    -- T5 worker dies mid-job -> lease expires -> redelivery reclaims it.
    INSERT INTO public.meeting_transcripts (meeting_id, status) VALUES (mid2, 'PENDING');
    r := public.claim_meeting_transcript(mid2);
    ASSERT r.attempts = 1, format('T5 first attempts=%s', r.attempts);
    -- Simulate the passage of time past the 600s lease.
    UPDATE public.meeting_transcripts
       SET claimed_at = now() - make_interval(secs => public.meeting_transcript_lease_seconds() + 60)
     WHERE meeting_id = mid2;
    r := public.claim_meeting_transcript(mid2);
    -- r.meeting_id, not `r IS NOT NULL`: on a row value that is true only when
    -- every column is non-null, and a claimed row always has NULL columns.
    ASSERT r.meeting_id IS NOT NULL, 'T5 expired lease not reclaimable';
    ASSERT r.status = 'PROCESSING', format('T5 status=%s', r.status);
    ASSERT r.attempts = 2, format('T5 attempts=%s', r.attempts);
    res := res || jsonb_build_object('T5', jsonb_build_object('reclaimed', true, 'attempts', r.attempts));

    -- T6 a LIVE lease is not stolen by a concurrent delivery.
    INSERT INTO public.meeting_transcripts (meeting_id, status) VALUES (mid3, 'PENDING');
    r := public.claim_meeting_transcript(mid3);
    ASSERT r.attempts = 1, format('T6 attempts=%s', r.attempts);
    r := public.claim_meeting_transcript(mid3);
    ASSERT r IS NULL, format('T6 live lease stolen: %s', r.status);
    ASSERT (SELECT attempts FROM public.meeting_transcripts WHERE meeting_id = mid3) = 1, 'T6 attempts bumped on refusal';
    res := res || jsonb_build_object('T6', 'live lease refused');

    -- T7 after the attempt cap the row is FAILED, not retried forever.
    INSERT INTO public.meeting_transcripts (meeting_id, status, attempts, claimed_at)
    VALUES (mid4, 'PROCESSING', public.meeting_transcript_max_attempts(),
            now() - make_interval(secs => public.meeting_transcript_lease_seconds() + 60));
    r := public.claim_meeting_transcript(mid4);
    ASSERT r IS NULL, format('T7 claimed past the attempt cap: %s', r.status);
    ASSERT (SELECT status FROM public.meeting_transcripts WHERE meeting_id = mid4) = 'FAILED', 'T7 not failed';
    ASSERT (SELECT error_message FROM public.meeting_transcripts WHERE meeting_id = mid4) LIKE '%attempts%',
        'T7 error message missing';
    res := res || jsonb_build_object('T7', jsonb_build_object(
        'status', (SELECT status FROM public.meeting_transcripts WHERE meeting_id = mid4),
        'error', (SELECT error_message FROM public.meeting_transcripts WHERE meeting_id = mid4)));

    RAISE EXCEPTION 'TEST_RESULTS %', res;
END
$test$;
