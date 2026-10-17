# Self-check for the auth gates on /start-jitsi, /stop-jitsi and /status.
# Stubs GCP and Supabase; never calls them. Run: python check_auth.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.update(WORKER_SERVICE_ACCOUNT="vmtb-services@vmtb-new.iam.gserviceaccount.com",
                  JITSI_ACTIVATOR_URL="https://act.example", SUPABASE_URL="https://sb.example",
                  SUPABASE_SERVICE_ROLE_KEY="k")
import main
from fastapi.testclient import TestClient
from unittest import mock

GOOD = "a" * 64
main.vm_status = lambda: "TERMINATED"
main.probe_jitsi_public = lambda: False
main._service_url = lambda name: ""
main.compute_client = lambda: mock.Mock()

class R:
    def __init__(s, code, data): s.status_code, s._d = code, data
    def json(s): return s._d
def fake_get(url, params, headers, timeout):
    assert params["token"] == f"eq.{GOOD}"
    return R(200, [{"user_id": "u", "mtb_id": "m", "expires_at": "2999-01-01T00:00:00Z"}])
main.httpx.get = fake_get

seen = {}
def fake_verify(token, req, audience=None):
    seen["aud"] = audience
    if token == "worker": return {"email": os.environ["WORKER_SERVICE_ACCOUNT"], "email_verified": True}
    if token == "other": return {"email": "x@y.iam.gserviceaccount.com", "email_verified": True}
    raise ValueError("bad")
main.google_id_token.verify_oauth2_token = fake_verify

c = TestClient(main.app)
T = {"X-Join-Ticket": GOOD}; W = {"Authorization": "Bearer worker"}
cases = [
    ("POST", "/start-jitsi", {}, 401), ("POST", "/start-jitsi", T, 200),
    ("POST", "/start-jitsi", {"X-Join-Ticket": "bad'),or(x"}, 401),
    ("POST", "/stop-jitsi", {}, 401), ("POST", "/stop-jitsi", T, 401),
    ("POST", "/stop-jitsi", {"Authorization": "Bearer other"}, 401),
    ("POST", "/stop-jitsi", {"Authorization": "Bearer junk"}, 401),
    ("POST", "/stop-jitsi", W, 200),
    ("GET", "/status", {}, 401), ("GET", "/status", T, 200),
    ("GET", "/", {}, 200),
]
for m, path, h, want in cases:
    got = c.request(m, path, headers=h).status_code
    assert got == want, (m, path, h, got, want)
assert seen["aud"] == "https://act.example", seen
os.environ["JITSI_ACTIVATOR_URL"] = ""
assert c.post("/stop-jitsi", headers=W).status_code == 401  # fails closed without audience
print(f"all {len(cases)+2} checks passed")
