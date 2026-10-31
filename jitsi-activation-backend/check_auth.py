# Self-check for the auth gates on /start-jitsi, /stop-jitsi, /reap-idle and /status.
# Stubs GCP and Supabase; never calls them. Run: python check_auth.py
import os, sys
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
main.vm_status = lambda: "TERMINATED"
main.vm_instance = lambda: mock.Mock(status="TERMINATED", last_start_timestamp="")
main.probe_jitsi_public = lambda: False
main._service_url = lambda name: ""
main.compute_client = lambda: mock.Mock()
main.record_start_poll = lambda: None  # telemetry stub; guarded in check_reap.py

class R:
    def __init__(s, code, data): s.status_code, s._d = code, data
    def json(s): return s._d
def fake_get(url, params, headers, timeout):
    assert params["token"] == f"eq.{GOOD}"
    return R(200, [{"user_id": "u", "mtb_id": "m", "expires_at": "2999-01-01T00:00:00Z"}])
main.httpx.get = fake_get

seen = {"auds": []}
def fake_verify(token, req, audience=None):
    seen["auds"].append((token, audience))
    # Audience-bound, like real verify_oauth2_token: a token minted for one
    # audience must not satisfy another (worker vs reaper separation).
    if token == "worker" and audience == "https://act.example":
        return {"email": os.environ["WORKER_SERVICE_ACCOUNT"], "email_verified": True}
    if token == "reaper" and audience == "https://act.example/reap-idle":
        return {"email": os.environ["REAPER_SERVICE_ACCOUNT"], "email_verified": True}
    if token == "other": return {"email": "x@y.iam.gserviceaccount.com", "email_verified": True}
    raise ValueError("bad")
main.google_id_token.verify_oauth2_token = fake_verify

c = TestClient(main.app)
T = {"X-Join-Ticket": GOOD}; W = {"Authorization": "Bearer worker"}
RP = {"Authorization": "Bearer reaper"}
cases = [
    ("POST", "/start-jitsi", {}, 401), ("POST", "/start-jitsi", T, 200),
    ("POST", "/start-jitsi", {"X-Join-Ticket": "bad'),or(x"}, 401),
    ("POST", "/stop-jitsi", {}, 401), ("POST", "/stop-jitsi", T, 401),
    ("POST", "/stop-jitsi", {"Authorization": "Bearer other"}, 401),
    ("POST", "/stop-jitsi", {"Authorization": "Bearer junk"}, 401),
    ("POST", "/stop-jitsi", W, 200),
    ("POST", "/reap-idle", {}, 401), ("POST", "/reap-idle", T, 401),
    ("POST", "/reap-idle", {"Authorization": "Bearer worker"}, 401),  # wrong audience
    ("POST", "/reap-idle", {"Authorization": "Bearer other"}, 401),   # wrong SA
    ("POST", "/reap-idle", {"Authorization": "Bearer junk"}, 401),
    ("POST", "/reap-idle", RP, 200),
    ("GET", "/status", {}, 401), ("GET", "/status", T, 200),
    ("GET", "/", {}, 200),
]
for m, path, h, want in cases:
    got = c.request(m, path, headers=h).status_code
    assert got == want, (m, path, h, got, want)
assert ("worker", "https://act.example") in seen["auds"], seen
assert ("reaper", "https://act.example/reap-idle") in seen["auds"], seen
os.environ["JITSI_ACTIVATOR_URL"] = ""
assert c.post("/stop-jitsi", headers=W).status_code == 401  # fails closed without audience
os.environ["REAPER_AUDIENCE"] = ""
assert c.post("/reap-idle", headers=RP).status_code == 401  # reaper fails closed too
print(f"all {len(cases)+3} checks passed")
