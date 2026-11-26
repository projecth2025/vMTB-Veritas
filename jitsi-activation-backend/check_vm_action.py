# Self-check for the GCP status -> action table used by /start-jitsi and
# /stop-jitsi (issue #69 part 2). Stubs GCP and Supabase; never calls them.
# Run: python check_vm_action.py
#
# The contract: every GCP instance status has an explicit action for each
# intent, no status is inferred from "is it RUNNING?", and no GCP call is ever
# issued at an instance that is booting, shutting down or repairing.
import os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(WORKER_SERVICE_ACCOUNT="vmtb-services@vmtb-new.iam.gserviceaccount.com",
                  JITSI_ACTIVATOR_URL="https://act.example",
                  REAPER_SERVICE_ACCOUNT="vmtb-services@vmtb-new.iam.gserviceaccount.com",
                  REAPER_AUDIENCE="https://act.example/reap-idle",
                  SUPABASE_URL="https://sb.example",
                  SUPABASE_SERVICE_ROLE_KEY="k")
import main
from fastapi.testclient import TestClient
from unittest import mock

GOOD = "a" * 64
cases = []

# --- 1. The pure mapping table, one row per GCP status. ---------------------
EXPECTED = {
    # status:        (start intent, stop intent)
    "RUNNING":       ("probe", "stop"),
    "PROVISIONING":  ("wait", "wait"),
    "STAGING":       ("wait", "wait"),
    "STOPPING":      ("wait", "wait"),
    "TERMINATED":    ("start", "already_stopped"),
    "SUSPENDING":    ("wait", "stop"),
    "SUSPENDED":     ("resume", "stop"),
    "REPAIRING":     ("error", "error"),
}
for status, (want_start, want_stop) in EXPECTED.items():
    got = (main.vm_action(status, "start"), main.vm_action(status, "stop"))
    assert got == (want_start, want_stop), (status, got)
    cases.append(f"{status} -> {want_start}/{want_stop}")

# Unknown / empty status must never be guessed at.
for weird in ("UNKNOWN", "", "DELETED", "SUSPENDED_FOR_MAINTENANCE"):
    assert main.vm_action(weird, "start") == "error", weird
    assert main.vm_action(weird, "stop") == "error", weird
cases.append("unknown status is error")

# --- 2. Endpoint behaviour: which GCP call actually fires. ------------------
fake_verify_calls = []
def fake_verify(token, req, audience=None):
    fake_verify_calls.append((token, audience))
    if token == "worker" and audience == "https://act.example":
        return {"email": os.environ["WORKER_SERVICE_ACCOUNT"], "email_verified": True}
    raise ValueError("bad")
main.google_id_token.verify_oauth2_token = fake_verify


class R:
    def __init__(s, code, data): s.status_code, s._d = code, data
    def json(s): return s._d


def fake_get(url, params, headers, timeout):
    return R(200, [{"user_id": "u", "mtb_id": "m", "expires_at": "2999-01-01T00:00:00Z"}])


main.httpx.get = fake_get
main.record_start_poll = lambda: None  # telemetry; guarded in check_reap.py
main._service_url = lambda name: ""
main.probe_jitsi_public = lambda: True

W = {"Authorization": "Bearer worker"}
T = {"X-Join-Ticket": GOOD}
c = TestClient(main.app)


def rfc(dt): return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def stub_vm(status, resume_ok=True):
    """Install a fake GCP client that records start/stop/resume calls."""
    instance = mock.Mock(
        status=status,
        last_start_timestamp=rfc(datetime.now(timezone.utc) - timedelta(minutes=60)),
    )
    client = mock.Mock()
    client.get.return_value = instance
    main.compute_client = lambda: client
    # Idle signals so a RUNNING stop is allowed past the shared guards.
    main.last_start_poll_at = lambda: datetime.now(timezone.utc) - timedelta(minutes=20)
    main.has_active_meeting = lambda within_minutes: False
    main.vm_network_bytes = lambda instance_id, minutes: 0
    return client


# /start-jitsi: only TERMINATED calls start; SUSPENDED calls resume; everything
# mid-flight makes no call at all; REPAIRING/unknown surface the status.
for status, expect in [
    ("TERMINATED", "start"),
    ("SUSPENDED", "resume"),
    ("RUNNING", "probe"),
    ("PROVISIONING", "none"),
    ("STAGING", "none"),
    ("STOPPING", "none"),
    ("SUSPENDING", "none"),
    ("REPAIRING", "error"),
    ("WIBBLING", "error"),
]:
    client = stub_vm(status)
    r = c.post("/start-jitsi", headers=T)
    assert r.status_code == 200, (status, r.status_code, r.text)
    body = r.json()
    jvb = body["components"]["jvb"]
    if expect == "start":
        client.start.assert_called_once()
        client.resume.assert_not_called()
        client.stop.assert_not_called()
        assert jvb["state"] == "starting", (status, jvb)
    elif expect == "resume":
        client.resume.assert_called_once()
        client.start.assert_not_called()
        client.stop.assert_not_called()
        assert jvb["state"] == "starting", (status, jvb)
    elif expect == "probe":
        client.start.assert_not_called()
        client.resume.assert_not_called()
        client.stop.assert_not_called()
        assert jvb["state"] == "ready", (status, jvb)
    elif expect == "none":
        client.start.assert_not_called()
        client.resume.assert_not_called()
        client.stop.assert_not_called()
        assert jvb["state"] == "starting", (status, jvb)
        assert status in jvb["detail"], (status, jvb)
    else:  # error
        client.start.assert_not_called()
        client.resume.assert_not_called()
        client.stop.assert_not_called()
        assert jvb["state"] == "error", (status, jvb)
        assert status in jvb["detail"], (status, jvb)
    cases.append(f"start-jitsi {status} -> {expect}")

# /stop-jitsi: only RUNNING/SUSPENDING/SUSPENDED call stop; nothing is issued
# while the VM boots or shuts down; REPAIRING/unknown is a 500 with the status.
for status, expect in [
    ("RUNNING", "stop"),
    ("SUSPENDED", "stop"),
    ("SUSPENDING", "stop"),
    ("TERMINATED", "already_stopped"),
    ("PROVISIONING", "none"),
    ("STAGING", "none"),
    ("STOPPING", "none"),
    ("REPAIRING", "error"),
    ("WIBBLING", "error"),
]:
    client = stub_vm(status)
    r = c.post("/stop-jitsi", headers=W)
    jvb = r.json()["components"]["jvb"]
    if expect == "stop":
        assert r.status_code == 200, (status, r.status_code, r.text)
        client.stop.assert_called_once()
        client.start.assert_not_called()
        assert jvb["state"] == "stopping", (status, jvb)
    elif expect == "already_stopped":
        assert r.status_code == 200, (status, r.status_code, r.text)
        client.stop.assert_not_called()
        assert jvb["state"] == "stopped", (status, jvb)
    elif expect == "none":
        assert r.status_code == 200, (status, r.status_code, r.text)
        client.stop.assert_not_called()
        assert jvb["state"] == "stopping", (status, jvb)
        assert status in jvb["detail"], (status, jvb)
    else:  # error -> 5xx so the worker retries / the log shows it
        assert r.status_code == 500, (status, r.status_code, r.text)
        client.stop.assert_not_called()
        assert jvb["state"] == "error", (status, jvb)
        assert status in jvb["detail"], (status, jvb)
    cases.append(f"stop-jitsi {status} -> {expect}")

# --- 3. /stop-jitsi shares the reaper's guards unless forced. ----------------
# A RUNNING VM someone is actively using must not be stopped by a plain call.
client = stub_vm("RUNNING")
main.has_active_meeting = lambda within_minutes: True  # live meeting heartbeat
r = c.post("/stop-jitsi", headers=W)
assert r.status_code == 200, r.status_code
assert r.json()["status"] == "skipped", r.json()
assert "heartbeat" in r.json()["reason"], r.json()
client.stop.assert_not_called()
cases.append("stop-jitsi skipped on live heartbeat")

# The same call with force=true stops it anyway (explicit operator override).
r = c.post("/stop-jitsi", headers=W, params={"force": "true"})
assert r.status_code == 200, r.status_code
client.stop.assert_called_once()
cases.append("force=true bypasses the guards")

# An unreadable signal fails safe: skip, never stop.
client = stub_vm("RUNNING")
main.vm_network_bytes = lambda instance_id, minutes: (_ for _ in ()).throw(RuntimeError("monitoring down"))
r = c.post("/stop-jitsi", headers=W)
assert r.status_code == 200 and r.json()["status"] == "skipped", r.json()
client.stop.assert_not_called()
cases.append("stop-jitsi fails safe on unreadable signal")

print(f"all {len(cases)} checks passed: {'; '.join(cases)}")
