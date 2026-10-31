-- Single-row activity ledger for the jitsi-activation-backend idle reaper.
--
-- /start-jitsi stamps last_start_poll_at (throttled to ~1 write/min) whenever
-- a waiting-room client polls it. The reaper (POST /reap-idle, invoked every
-- 5 min by Cloud Scheduler) reads it to tell "a human is waiting for the VM to
-- boot" apart from "the VM was booted and then forgotten" -- the leak where a
-- VM booted via the waiting room stayed on (billing) forever because no
-- meeting.completed event ever fired to stop it.
--
-- Exactly one row (id = true). Written only by the activation backend's
-- service-role client; never readable by the browser.

CREATE TABLE IF NOT EXISTS public.jitsi_vm_activity (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    last_start_poll_at TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row guarantee: only the sentinel id may ever exist.
ALTER TABLE public.jitsi_vm_activity
    ADD CONSTRAINT jitsi_vm_activity_single_row CHECK (id);

-- No policies on purpose: anon/authenticated get nothing (same posture as
-- meeting_join_tickets). The service-role client bypasses RLS.
ALTER TABLE public.jitsi_vm_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jitsi_vm_activity FROM anon, authenticated;

COMMENT ON TABLE public.jitsi_vm_activity IS
    'Single-row ledger of recent jitsi-activation-backend /start-jitsi poll activity. Read by the idle reaper to decide whether an idle jitsi-vm may be stopped.';
COMMENT ON COLUMN public.jitsi_vm_activity.last_start_poll_at IS
    'When a waiting-room client last polled /start-jitsi. NULL = never recorded.';
