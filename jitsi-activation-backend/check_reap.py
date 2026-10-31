# Self-check for the /reap-idle guard logic. Stubs GCP and Supabase; never
# calls them. Run: python check_reap.py
#
# The reaper's contract: the VM is stopped ONLY when every guard says nobody
# needs it, and any unreadable signal means "unknown" -> skip, never stop.
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


def fake_verify(token, req, audience=None):
    if token == "reaper" and audience == "https://act.example/reap-idle":
        return {"email": os.environ["REAPER_SERVICE_ACCOUNT"], "email_verified": True}
    raise ValueError("bad")
main.google_id_token.verify_oauth2_token = fake_verify
REAL_VM_NETWORK_BYTES = main.vm_network_bytes

RP = {"Authorization": "Bearer reaper"}
c = TestClient(main.app)


def rfc(dt): return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def setup(status="RUNNING", started_minutes_ago=60, poll_minutes_ago=20,
          active=False, stop_raises=False, no_start_ts=False, traffic=0):
    """(re)stub the world for one reaper invocation. Returns the stop mock."""
    instance = mock.Mock(status=status,
                         last_start_timestamp="" if no_start_ts
                         else rfc(datetime.now(timezone.utc) - timedelta(minutes=started_minutes_ago)))
    client = mock.Mock()
    client.get.return_value = instance
    client.stop.side_effect = RuntimeError("gcp down") if stop_raises else None
    main.compute_client = lambda: client
    main.last_start_poll_at = (
        (lambda: (_ for _ in ()).throw(RuntimeError("sb down")))
        if poll_minutes_ago is None else
        (lambda: None if poll_minutes_ago == "never"
         else datetime.now(timezone.utc) - timedelta(minutes=poll_minutes_ago))
    )
    main.has_active_meeting = lambda within_minutes: active
    # traffic: bytes, None (no samples) or an Exception (API failure)
    def fake_traffic(instance_id, minutes):
        if isinstance(traffic, Exception): raise traffic
        return traffic
    main.vm_network_bytes = fake_traffic
    return client.stop


def reap():
    r = c.post("/reap-idle", headers=RP)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)


cases = []

# 1. Stopped VM: nothing to reap.
stop = setup(status="TERMINATED")
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
cases.append("stopped vm skipped")

# 2. Fresh boot: boot grace protects a user still in the waiting room.
stop = setup(started_minutes_ago=2, poll_minutes_ago=20)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "boot grace" in body["reason"], body
cases.append("boot grace skipped")

# 3. Waiting-room poll within the idle window: a human is waiting for boot.
stop = setup(started_minutes_ago=60, poll_minutes_ago=0.5)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "poll" in body["reason"], body
cases.append("recent poll skipped")

# 4. Live meeting heartbeat.
stop = setup(started_minutes_ago=60, poll_minutes_ago=20, active=True)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "heartbeat" in body["reason"], body
cases.append("active heartbeat skipped")

# 5. Poll signal unreadable -> fail safe, never stop.
stop = setup(started_minutes_ago=60, poll_minutes_ago=None)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "fail-safe" in body["reason"], body
cases.append("poll read failure fails safe")

# 6. Heartbeat signal unreadable -> fail safe, never stop.
stop = setup(started_minutes_ago=60, poll_minutes_ago=20)
main.has_active_meeting = lambda within_minutes: (_ for _ in ()).throw(RuntimeError("sb down"))
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "fail-safe" in body["reason"], body
cases.append("heartbeat read failure fails safe")

# 7. Missing boot timestamp -> fail safe.
stop = setup(started_minutes_ago=60, no_start_ts=True)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
cases.append("missing boot timestamp fails safe")

# 8. GCP stop failure surfaces as 5xx (so the scheduler log shows it).
stop = setup(started_minutes_ago=60, poll_minutes_ago=20, stop_raises=True)
code, body = reap()
assert (code, body["status"]) == (500, "error"), (code, body)
cases.append("stop failure is 5xx")

# 9. Genuinely idle (manual gcloud start: poll never recorded) -> STOP.
stop = setup(started_minutes_ago=60, poll_minutes_ago="never")
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "stopped", 1), body
assert body["poll_idle_seconds"] is None, body
cases.append("idle vm with no poll record stopped")

# 10. Abandoned waiting room (poll aged out, no heartbeat) -> STOP.
stop = setup(started_minutes_ago=60, poll_minutes_ago=20)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "stopped", 1), body
assert 20 * 60 - 5 <= body["poll_idle_seconds"] <= 20 * 60, body
cases.append("abandoned waiting room stopped")

# 11. Forged heartbeat (anyone with the anon key can mark a live meeting
#     ended while meeting_sessions RLS is off) but the VM is moving media -> skip.
stop = setup(started_minutes_ago=60, poll_minutes_ago=20, traffic=6_000_000)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
assert "traffic" in body["reason"], body
cases.append("live traffic skipped despite no heartbeat")

# 12/13. Traffic unreadable or never sampled -> fail safe.
for t, name in ((RuntimeError("monitoring down"), "traffic read failure"), (None, "no traffic samples")):
    stop = setup(started_minutes_ago=60, poll_minutes_ago=20, traffic=t)
    code, body = reap()
    assert (code, body["status"], stop.call_count) == (200, "skipped", 0), body
    assert "fail-safe" in body["reason"], body
    cases.append(f"{name} fails safe")

# 14. Idle background noise below the threshold still stops.
stop = setup(started_minutes_ago=60, poll_minutes_ago=20, traffic=300_000)
code, body = reap()
assert (code, body["status"], stop.call_count) == (200, "stopped", 1), body
cases.append("idle noise below threshold stopped")

# vm_network_bytes: sums every point of both metrics; no points -> None.
class FakeSession:
    pages = {}
    def __init__(self, creds): pass
    def get(self, url, params, timeout):
        metric = params["filter"].split("/network/")[1].split('"')[0]
        r = mock.Mock(); r.raise_for_status = lambda: None
        r.json = lambda: FakeSession.pages.get(metric, {})
        return r
vm_network_bytes = REAL_VM_NETWORK_BYTES
main.AuthorizedSession = FakeSession
main._credentials = lambda: object()
FakeSession.pages = {
    "sent_bytes_count": {"timeSeries": [{"points": [{"value": {"int64Value": "100"}}, {"value": {"int64Value": "50"}}]},
                                         {"points": [{"value": {"int64Value": "5"}}]}]},
    "received_bytes_count": {"timeSeries": [{"points": [{"value": {"int64Value": "1000"}}]}]},
}
assert vm_network_bytes("1", 10) == 1155
FakeSession.pages = {}
assert vm_network_bytes("1", 10) is None
cases.append("vm_network_bytes sums both metrics, None without samples")

# record_start_poll: throttled writes, failure swallowed (never breaks a poll).
main.cfg.poll_write_interval_seconds = 60
writes = []
class FakeResp:
    status_code = 200
    text = ""
main.httpx.post = lambda url, params, headers, json, timeout=None: (writes.append(json), FakeResp())[1]
main._last_poll_write = None
main.record_start_poll()
main.record_start_poll()  # throttled - must not write twice
assert len(writes) == 1 and writes[0]["id"] is True and writes[0]["last_start_poll_at"], writes
main.httpx.post = lambda url, params, headers, json, timeout=None: (_ for _ in ()).throw(RuntimeError("sb down"))
main._last_poll_write = None
main.record_start_poll()  # failure swallowed, throttle not consumed
assert main._last_poll_write is None
cases.append("record_start_poll throttled + failure-swallowing")

print(f"all {len(cases)} checks passed: {'; '.join(cases)}")
