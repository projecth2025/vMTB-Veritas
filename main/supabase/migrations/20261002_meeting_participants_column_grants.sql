-- ============================================================================
-- Restrict client writes on meeting_participants to the leave-tracking columns
-- ============================================================================
-- Supersedes 20261001_lock_meeting_participants_writes.sql, which is deleted in
-- the same commit and was never applied. That migration was wrong twice over:
--
--   1. It only dropped two policies. RLS is DISABLED on this table (confirmed
--      by the Supabase advisor: both `policy_exists_rls_disabled` and
--      `rls_disabled_in_public` flag it), so dropping policies would not have
--      enforced anything at all.
--   2. A blanket write lockdown would have broken jitsi-frontend's leave
--      tracking, which still updates this table with the anon key.
--
-- Column-level grants are the right tool: they are enforced by PostgREST
-- regardless of whether RLS is on, and they can draw the line between "when
-- this participant left" (the client legitimately knows this) and "who this
-- participant is" (only the server may assert this).
--
-- Since PR #42 the client no longer INSERTs participant rows at all -- the
-- meeting_participant_identity Edge Function creates them with the service-role
-- key after verifying a join ticket against profiles. So the client needs no
-- INSERT, and UPDATE on exactly the three columns markParticipantLeft() writes.
--
-- service_role bypasses all of this, so the Edge Function is unaffected.
-- ============================================================================

REVOKE INSERT, UPDATE ON public.meeting_participants FROM anon, authenticated;

-- Exactly the columns jitsi-frontend's markParticipantLeft() sets. Notably NOT
-- updated_at: the client never names it in its UPDATE, and Postgres checks
-- column privileges only against the columns a statement names -- not against
-- columns a BEFORE trigger assigns. So update_meeting_participants_updated_at
-- still bumps updated_at on every leave update without a grant of its own.
GRANT UPDATE (left_at, duration_seconds, left_reason)
    ON public.meeting_participants TO anon, authenticated;

-- user_id, verified_name, verified_profession and verified_at are in neither
-- grant. A browser therefore cannot write a speaker identity, nor rewrite one
-- after the fact -- which is the whole point of the join-ticket flow.

COMMENT ON TABLE public.meeting_participants IS
    'One row per participant join, created server-side by the meeting_participant_identity Edge Function after it verifies a join ticket. Clients may update only left_at/duration_seconds/left_reason. display_name records what the participant chose to show on their tile and is NOT trusted for transcript attribution -- verified_name/verified_profession are.';
