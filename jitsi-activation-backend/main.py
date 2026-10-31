"""vMTB meeting infrastructure activation service.

Brings up (and tears down) every billable component a meeting needs:

  - ``jitsi-vm``            Compute Engine VM running JVB/Prosody/Jicofo
  - ``stt-service``         Cloud Run GPU service, scale-to-zero
  - ``opus-transcriber-proxy``  Cloud Run service, scale-to-zero

Cost model (important): this service NEVER writes Cloud Run scaling
configuration. A previous design patched ``min_instance_count`` 0->1 before a
meeting and back to 0 afterwards; when the "back to 0" step was forgotten, an
idle L4 GPU stayed resident for days (~Rs 56/hour). Instead, scale-from-zero
is driven purely by requests: each poll below issues an authenticated health
probe, and that request itself starts the GPU instance if it is cold.
Subsequent polls observe readiness, and Cloud Run reaps the instance by itself
once the meeting's WebSocket closes and traffic stops.

``POST /start-jitsi`` is polled by jitsi-frontend every few seconds until it
returns ``{"status": "already_running"}``, which means ALL components are up.
The endpoint is idempotent: each poll re-checks state and never blocks for
long.

``POST /reap-idle`` is the cost-safety net: invoked every 30 min by Cloud
Scheduler (OIDC ID token, audience ``REAPER_AUDIENCE``). The transcript-worker
only stops the VM after a ``meeting.completed`` event; a VM booted via the
waiting room whose meeting never happened leaked forever. The reaper stops the
VM only when EVERY guard says nobody needs it: instance RUNNING past the boot
grace, no ``/start-jitsi`` poll within ``VM_IDLE_MINUTES``, and no live
meeting-session heartbeat. Every read failure fails SAFE (skip, never stop).

Credentials come from Application Default Credentials (the service account
attached to this Cloud Run service). For local development you can instead set
``GCP_SERVICE_ACCOUNT_JSON`` to a full service-account JSON blob. The runtime
service account needs only:
  - Compute Engine instance start/stop/get on jitsi-vm
  - roles/run.invoker on stt-service and opus-transcriber-proxy (probes)
  - roles/run.viewer (to read the services' URLs)
"""

import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import google.auth
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.auth.credentials import with_scopes_if_required
from google.auth.transport.requests import AuthorizedSession
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.cloud import compute_v1
from google.oauth2 import id_token as google_id_token
from google.oauth2 import service_account

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("activation")

app = FastAPI(title="vMTB activation backend")

_DEFAULT_CORS_ORIGINS = ",".join(
    [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://vmtb-v2.3billionpairs.com",
        "https://server-vmtb-v2.3billionpairs.com",
        "https://meeting-vmtb-v2.3billionpairs.com",
    ]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get("CORS_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",")
        if o.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Config:
    """Environment-driven configuration; no secrets hardcoded."""

    def __init__(self) -> None:
        self.project_id = os.environ.get("GCP_PROJECT_ID", "")
        self.zone = os.environ.get("GCP_ZONE", "asia-south1-c")
        self.instance_name = os.environ.get("JITSI_INSTANCE_NAME", "jitsi-vm")
        # Region where the Cloud Run services live (STT needs a GPU region;
        # asia-south1 L4 is invite-only, so the default is Singapore).
        self.region = os.environ.get("GCP_REGION", "asia-southeast1")
        self.stt_service_name = os.environ.get("STT_SERVICE_NAME", "stt-service")
        self.proxy_service_name = os.environ.get(
            "PROXY_SERVICE_NAME", "opus-transcriber-proxy"
        )
        # Per-request timeout for health probes. A cold GPU STT blocks its
        # first request while the container boots and the model loads; later
        # polls succeed quickly once /ready answers.
        self.stt_probe_timeout_seconds = float(
            os.environ.get("STT_PROBE_TIMEOUT_SECONDS", "15")
        )
        self.proxy_probe_timeout_seconds = float(
            os.environ.get("PROXY_PROBE_TIMEOUT_SECONDS", "8")
        )
        # Public Jitsi origin on the VM. GCP reports RUNNING before nginx and
        # Prosody finish booting; probing this URL (default: the real meet
        # host) keeps /start-jitsi in "starting" until the browser can
        # actually load external_api.js and open /xmpp-websocket.
        self.jitsi_public_url = os.environ.get(
            "JITSI_PUBLIC_URL", "https://server-vmtb-v2.3billionpairs.com"
        )
        self.jitsi_probe_timeout_seconds = float(
            os.environ.get("JITSI_PROBE_TIMEOUT_SECONDS", "5")
        )
        # --- Idle reaper (POST /reap-idle) ---------------------------------
        # The VM may only be reaped once EVERY signal says nobody needs it.
        # vm_idle_minutes: how long since the last sign of life (waiting-room
        #   /start-jitsi poll, or VM boot when no poll was ever recorded)
        #   before the reaper may stop the VM. Also the boot grace: a fresh
        #   boot is never reaped within this window, protecting a user who is
        #   still sitting in the waiting room.
        # heartbeat_grace_minutes: how fresh a meeting_sessions heartbeat must
        #   be to count as "someone is in a meeting right now" - same
        #   predicate the transcript-worker uses before firing /stop-jitsi.
        # poll_write_interval_seconds: throttle for the activity upsert done
        #   on every /start-jitsi poll (frontend polls every ~5s; one write
        #   per minute per instance is plenty of resolution for a 30-min
        #   reaper tick).
        # active_traffic_bytes: VM network bytes (sent + received) over the
        #   last vm_idle_minutes at or above which a call is assumed to be
        #   live. Oct 2026 data per 10 min: idle <= 0.3 MB, a 2-person
        #   audio-only call ~6 MB. Bots loading the Jitsi page (~5 MB) only
        #   delay a stop to the next tick.
        self.vm_idle_minutes = float(os.environ.get("VM_IDLE_MINUTES", "10"))
        self.heartbeat_grace_minutes = float(
            os.environ.get("VM_HEARTBEAT_GRACE_MINUTES", "3")
        )
        self.poll_write_interval_seconds = float(
            os.environ.get("POLL_ACTIVITY_WRITE_INTERVAL_SECONDS", "60")
        )
        self.active_traffic_bytes = float(
            os.environ.get("VM_ACTIVE_TRAFFIC_BYTES", "1000000")
        )


cfg = Config()

# ---------------------------------------------------------------------------
# Lazy GCP clients (initialised on first use so /health works without creds)
# ---------------------------------------------------------------------------

_compute_client: compute_v1.InstancesClient | None = None


def _credentials():
    raw = os.environ.get("GCP_SERVICE_ACCOUNT_JSON")
    if raw:
        return service_account.Credentials.from_service_account_info(
            json.loads(raw)
        )
    credentials, _ = google.auth.default()
    return credentials


def compute_client() -> compute_v1.InstancesClient:
    global _compute_client
    if _compute_client is None:
        _compute_client = compute_v1.InstancesClient(credentials=_credentials())
    return _compute_client


def _service_url(service_name: str) -> str:
    """Read a Cloud Run service URL via the Admin API (read-only)."""
    from google.cloud import run_v2  # local import: only needed for reads

    client = run_v2.ServicesClient(credentials=_credentials())
    name = f"projects/{cfg.project_id}/locations/{cfg.region}/services/{service_name}"
    return client.get_service(name=name).uri or ""


def probe(base_url: str, path: str, timeout_seconds: float, require_status_ok: bool = False) -> bool:
    """GET a health endpoint, authenticating with an ID token when possible.

    The probe doubles as the scale-from-zero trigger: Cloud Run starts an
    instance to serve it. A cold STT instance may not answer within the first
    few attempts (model load); callers simply poll again.

    When ``require_status_ok`` is set, a 200 body must also carry
    ``{"status": "ok"}`` — /ready answers 200 with ``{"status": "loading"}``
    while the model is still coming up, which must not count as ready.
    """
    url = base_url.rstrip("/") + path
    headers: dict[str, str] = {}
    try:
        token = google_id_token.fetch_id_token(GoogleAuthRequest(), base_url)
        if token:
            headers["Authorization"] = f"Bearer {token}"
    except Exception as exc:  # noqa: BLE001 - fall back to unauthenticated
        log.debug("id token fetch failed for %s (%s); trying unauthenticated", base_url, exc)

    try:
        resp = httpx.get(url, headers=headers, timeout=timeout_seconds)
        if resp.status_code != 200:
            log.debug("probe %s -> %s", url, resp.status_code)
            return False
        if require_status_ok:
            try:
                body = resp.json()
            except Exception:  # noqa: BLE001 - non-JSON readiness = not ready
                return False
            if not isinstance(body, dict) or body.get("status") != "ok":
                log.debug("probe %s -> 200 but status=%s", url, body)
                return False
        return True
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.info("probe %s failed: %s", url, exc)
        return False


def vm_instance():
    """The Compute Engine instance object (status, last_start_timestamp, ...)."""
    return compute_client().get(
        project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
    )


def vm_status() -> str:
    return vm_instance().status or "UNKNOWN"


def probe_jitsi_public() -> bool:
    """GET the public Jitsi origin (no auth) — true when nginx is serving.

    Distinguishes "GCP instance RUNNING" from "meeting UI is reachable".
    Cold VM boot: GCP flips to RUNNING while cloud-init still has tens of
    seconds of work; early clients then hit ERR_CONNECTION_REFUSED on
    external_api.js / wss://…/xmpp-websocket. We keep reporting starting
    until the first byte of HTTPS content arrives.
    """
    url = cfg.jitsi_public_url.rstrip("/") + "/"
    try:
        resp = httpx.get(url, timeout=cfg.jitsi_probe_timeout_seconds, follow_redirects=True)
        ready = resp.status_code == 200
        if not ready:
            log.debug("jitsi public probe %s -> %s", url, resp.status_code)
        return ready
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.debug("jitsi public probe %s failed: %s", url, exc)
        return False


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
@app.head("/")
def health_check() -> Response:
    """Lightweight health check for uptime monitors and platform probes."""
    return Response(content="OK", status_code=200)


def verify_join_ticket(ticket: str) -> Optional[dict]:
    """Verify a join ticket against Supabase meeting_join_tickets table.

    Returns {"user_id": ..., "mtb_id": ...} if valid, None otherwise.
    """
    # Same shape the frontend accepts (64 lowercase hex); anything else never
    # reaches PostgREST.
    if not re.fullmatch(r"[a-f0-9]{64}", ticket):
        return None

    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not service_role_key:
        return None

    try:
        resp = httpx.get(
            f"{supabase_url.rstrip('/')}/rest/v1/meeting_join_tickets",
            params={
                "select": "user_id,mtb_id,expires_at",
                "token": f"eq.{ticket}",
                "limit": "1",
            },
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            timeout=5.0,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not data:
            return None
        row = data[0]
        # Check expiry
        expires_at = row.get("expires_at")
        if expires_at:
            from datetime import datetime, timezone
            exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if exp <= datetime.now(timezone.utc):
                return None
        return {
            "user_id": row.get("user_id"),
            "mtb_id": row.get("mtb_id"),
        }
    except Exception as exc:
        log.warning("join-ticket verification failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Idle-reaper signals (Supabase REST, service-role)
# ---------------------------------------------------------------------------

def _supabase_headers() -> Optional[dict[str, str]]:
    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not service_role_key:
        return None
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }


def _supabase_base_url() -> str:
    return os.environ["SUPABASE_URL"].rstrip("/")


# Per-process throttle for the activity upsert: the frontend polls
# /start-jitsi every ~5s, but one write per POLL_ACTIVITY_WRITE_INTERVAL_SECONDS
# is all the reaper's 30-minute tick needs. None = never written this instance.
_last_poll_write: Optional[float] = None


def record_start_poll() -> None:
    """Stamp "a waiting-room client is polling us" into jitsi_vm_activity.

    This is what lets the idle reaper tell a human waiting for boot apart from
    a VM that was booted and then forgotten. Throttled per process; any failure
    is swallowed on purpose - /start-jitsi must keep working, and the reaper
    fails safe (skips the stop) when it cannot read this signal.
    """
    global _last_poll_write
    headers = _supabase_headers()
    if not headers:
        return
    now_mono = time.monotonic()
    if _last_poll_write is not None and (
        now_mono - _last_poll_write < cfg.poll_write_interval_seconds
    ):
        return
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        resp = httpx.post(
            f"{_supabase_base_url()}/rest/v1/jitsi_vm_activity",
            params={"on_conflict": "id"},
            headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json={"id": True, "last_start_poll_at": now_iso, "updated_at": now_iso},
            timeout=3.0,
        )
        if resp.status_code >= 300:
            log.warning("record_start_poll: supabase %s %s", resp.status_code, resp.text[:200])
            return
        _last_poll_write = now_mono
    except Exception as exc:  # noqa: BLE001 - never fail /start-jitsi over telemetry
        log.warning("record_start_poll failed: %s", exc)


def last_start_poll_at() -> Optional[datetime]:
    """When a waiting-room client last polled /start-jitsi.

    Returns None when no poll has EVER been recorded (e.g. the VM was started
    by hand with gcloud - the reaper then falls back to the boot-time guard).
    Raises on Supabase failure: callers must treat "cannot read" as unknown
    and fail safe, never as "idle".
    """
    headers = _supabase_headers()
    if not headers:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    resp = httpx.get(
        f"{_supabase_base_url()}/rest/v1/jitsi_vm_activity",
        params={"select": "last_start_poll_at", "id": "eq.true", "limit": "1"},
        headers=headers,
        timeout=5.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"jitsi_vm_activity read failed: HTTP {resp.status_code}")
    data = resp.json()
    raw = data[0].get("last_start_poll_at") if data else None
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def has_active_meeting(within_minutes: float) -> Optional[bool]:
    """True when any meeting_sessions heartbeat is fresher than the grace.

    Same predicate transcript-worker's SupabaseStore.hasActiveSession uses
    before firing /stop-jitsi. Raises on Supabase failure; callers must treat
    "cannot read" as unknown and fail safe.
    """
    headers = _supabase_headers()
    if not headers:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured")
    cutoff = datetime.now(timezone.utc).timestamp() - within_minutes * 60
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
    resp = httpx.get(
        f"{_supabase_base_url()}/rest/v1/meeting_sessions",
        params={
            "select": "id",
            "status": "eq.active",
            "last_heartbeat": f"gte.{cutoff_iso}",
            "limit": "1",
        },
        headers=headers,
        timeout=5.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"meeting_sessions read failed: HTTP {resp.status_code}")
    return len(resp.json()) > 0


def vm_network_bytes(instance_id: str, minutes: float) -> Optional[int]:
    """Bytes the VM sent + received over the last `minutes` (Cloud Monitoring).

    Unlike meeting_sessions - browser-writable while its RLS is off - no
    client can fake this. Returns None when there are no samples; raises on
    API failure. Callers treat both as unknown and fail safe. Needs
    roles/monitoring.viewer on the backend's service account.
    """
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=minutes)
    session = AuthorizedSession(
        with_scopes_if_required(
            _credentials(), ["https://www.googleapis.com/auth/cloud-platform"]
        )
    )
    total, points = 0, 0
    # One metric per request: the API rejects a filter spanning two metrics.
    for metric in ("sent_bytes_count", "received_bytes_count"):
        resp = session.get(
            f"https://monitoring.googleapis.com/v3/projects/{cfg.project_id}/timeSeries",
            params={
                "filter": f'metric.type = "compute.googleapis.com/instance/network/{metric}"'
                f' AND resource.labels.instance_id = "{instance_id}"',
                "interval.startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "interval.endTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            timeout=10,
        )
        resp.raise_for_status()
        for series in resp.json().get("timeSeries", []):
            for point in series.get("points", []):
                total += int(point["value"].get("int64Value", 0))
                points += 1
    return total if points else None


# Missing auth config is a per-process condition - log it once loudly instead
# of once per request.
_auth_config_warned = False


def _verify_sa_id_token(
    token: str, expected_email: str, expected_audience: str, config_label: str
) -> Optional[dict]:
    """Shared Google ID-token gate: right SA email AND right audience.

    Both checks are mandatory: without the audience, any token minted for the
    same SA for a different purpose (proxy, Pub/Sub push) would pass.
    """
    global _auth_config_warned
    if not expected_email or not expected_audience:
        if not _auth_config_warned:
            log.error(
                "%s not set - every ID token for it will be rejected "
                "(see docs/JITSI_VM_OPERATIONS.md 'Auth')",
                config_label,
            )
            _auth_config_warned = True
        return None

    try:
        # Verify the token
        idinfo = google_id_token.verify_oauth2_token(
            token,
            GoogleAuthRequest(),
            audience=expected_audience,
        )

        # Check email matches expected service account
        email = idinfo.get("email", "")
        if email != expected_email or not idinfo.get("email_verified"):
            log.warning("id-token rejected: email=%r email_verified=%r", email, idinfo.get("email_verified"))
            return None

        return {
            "email": email,
            "sub": idinfo.get("sub"),
        }
    except Exception as exc:
        # Never log the token - just why Google refused it (expired, wrong
        # audience, unparseable). Without this, 401 storms were silent here.
        log.warning("id-token verification failed: %s", exc)
        return None


def verify_google_id_token(token: str) -> Optional[dict]:
    """Verify a Google ID token from the transcript-worker service account.

    Returns {"email": ..., "sub": ...} if valid, None otherwise.
    """
    # Must equal the worker's JITSI_ACTIVATOR_URL (the audience it mints for).
    # Without it, any token for the same SA (proxy, Pub/Sub push) would pass.
    return _verify_sa_id_token(
        token,
        os.environ.get("WORKER_SERVICE_ACCOUNT", ""),
        os.environ.get("JITSI_ACTIVATOR_URL", ""),
        "WORKER_SERVICE_ACCOUNT and/or JITSI_ACTIVATOR_URL",
    )


def verify_reaper_id_token(token: str) -> Optional[dict]:
    """Verify the Cloud Scheduler ID token that invokes POST /reap-idle.

    Separate audience from the worker's: the scheduler job mints for
    REAPER_AUDIENCE (default: JITSI_activator URL + "/reap-idle"), so a
    worker/proxy/Pub/Sub token for the base audience cannot drive the reaper
    and vice versa. Fails closed when the audience is unconfigurable.
    """
    email = os.environ.get("REAPER_SERVICE_ACCOUNT", "") or os.environ.get(
        "WORKER_SERVICE_ACCOUNT", ""
    )
    audience = os.environ.get("REAPER_AUDIENCE", "")
    if not audience:
        activator = os.environ.get("JITSI_ACTIVATOR_URL", "")
        if activator:
            audience = activator.rstrip("/") + "/reap-idle"
    return _verify_sa_id_token(
        token, email, audience, "REAPER_AUDIENCE (or JITSI_ACTIVATOR_URL)"
    )


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    x_join_ticket: Optional[str] = Header(default=None),
) -> Optional[dict]:
    """Verify caller identity via join ticket or Google ID token.

    Frontend (meet.vmtb.in): sends join ticket in X-Join-Ticket header.
    Worker: sends Google ID token in Authorization: Bearer header.

    Returns user info dict if valid, None otherwise.
    """
    # Check for join ticket (frontend)
    if x_join_ticket:
        result = verify_join_ticket(x_join_ticket)
        if result:
            return {"type": "join_ticket", **result}
        return None

    # Check for Google ID token (worker)
    if authorization and authorization.startswith("Bearer "):
        token = authorization[len("Bearer "):]
        if token:
            result = verify_google_id_token(token)
            if result:
                return {"type": "google_id_token", **result}

    return None


def get_reap_caller(
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """Auth gate for POST /reap-idle - Google ID token only, never a ticket.

    A join ticket is refused: a participant must never be able to stop the VM
    under a live meeting. Mirrors /stop-jitsi's posture.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    result = verify_reaper_id_token(authorization[len("Bearer "):])
    if result is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return result



@app.post("/start-jitsi")
def start_jitsi(current_user: Optional[dict] = Depends(get_current_user)) -> dict[str, Any]:
    """Bring every meeting component up. Safe to call repeatedly.

    Returns ``already_running`` only when the VM is RUNNING **and** its
    public HTTPS origin is serving **and** both Cloud Run services answer
    their health endpoints; otherwise ``starting``.

    Authentication: Requires valid join ticket (frontend) or Google ID token (worker).
    """
    if current_user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Signal for the idle reaper: a human is (im)patiently waiting for the VM
    # to boot right now. Throttled and failure-swallowing - see record_start_poll.
    record_start_poll()

    components: dict[str, dict[str, str]] = {}

    # 1. Jitsi VM (JVB / Prosody / Jicofo)
    #    GCP RUNNING alone is not enough — also require the public HTTPS
    #    origin to answer, so clients never race nginx/prosody during boot.
    try:
        status = vm_status()
        if status == "RUNNING":
            if probe_jitsi_public():
                components["jvb"] = {"state": "ready"}
            else:
                log.info(
                    "%s: RUNNING but %s not serving yet",
                    cfg.instance_name,
                    cfg.jitsi_public_url,
                )
                components["jvb"] = {
                    "state": "starting",
                    "detail": "vm running; waiting for jitsi https",
                }
        else:
            log.info("%s: starting (status=%s)", cfg.instance_name, status)
            compute_client().start(
                project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
            )
            components["jvb"] = {"state": "starting", "detail": f"vm {status}"}
    except Exception as exc:  # noqa: BLE001 - report per-component errors
        log.exception("jvb start check failed")
        components["jvb"] = {"state": "error", "detail": str(exc)}

    # 2. Scale-to-zero Cloud Run services: the authenticated probe below is
    # what starts a cold instance (request-driven wake). We deliberately do
    # NOT touch min-instances - see the module docstring for the cost story.
    services = (
        # stt: /ready returns 200 while status=="loading" — require status ok.
        ("stt", cfg.stt_service_name, "/ready", cfg.stt_probe_timeout_seconds, True),
        ("proxy", cfg.proxy_service_name, "/health", cfg.proxy_probe_timeout_seconds, False),
    )
    for key, name, health_path, probe_timeout, require_ok in services:
        try:
            url = _service_url(name)
            ready = bool(url) and probe(url, health_path, probe_timeout, require_status_ok=require_ok)
            components[key] = {"state": "ready" if ready else "starting"}
        except Exception as exc:  # noqa: BLE001
            log.exception("%s wake failed", name)
            components[key] = {"state": "error", "detail": str(exc)}

    all_ready = all(c["state"] == "ready" for c in components.values())
    payload = {
        "status": "already_running" if all_ready else "starting",
        "components": components,
    }
    log.info("/start-jitsi -> %s %s", payload["status"], components)
    return payload


@app.post("/stop-jitsi")
def stop_jitsi(current_user: Optional[dict] = Depends(get_current_user)):
    """Stop the billable VM.

    The Cloud Run services are intentionally left alone: they are
    request-driven and Cloud Run reaps their instances automatically once the
    meeting's WebSockets close (the STT service additionally closes sessions
    after an idle window). There is no resident-GPU state to clean up anymore.

    Authentication: Requires valid Google ID token from transcript-worker.
    A join ticket is not enough: any participant could end everyone's meeting.
    """
    if current_user is None or current_user.get("type") != "google_id_token":
        raise HTTPException(status_code=401, detail="Authentication required")

    components: dict[str, dict[str, str]] = {}
    stop_error: Exception | None = None

    try:
        status = vm_status()
        if status == "TERMINATED":
            components["jvb"] = {"state": "stopped"}
        else:
            log.info("%s: stopping (status=%s)", cfg.instance_name, status)
            compute_client().stop(
                project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
            )
            components["jvb"] = {"state": "stopping"}
    except Exception as exc:  # noqa: BLE001
        log.exception("jvb stop failed")
        components["jvb"] = {"state": "error", "detail": str(exc)}
        stop_error = exc

    for key, name in (("stt", cfg.stt_service_name), ("proxy", cfg.proxy_service_name)):
        components[key] = {"state": "scale-to-zero (automatic)"}

    all_down = components["jvb"]["state"] == "stopped"
    payload = {
        "status": "already_stopped" if all_down else ("error" if stop_error else "stopping"),
        "components": components,
    }
    log.info("/stop-jitsi -> %s", payload["status"])
    # Surface GCP failures as 5xx so the transcript-worker can retry instead
    # of logging "fired successfully" while the VM keeps billing.
    if stop_error is not None:
        return JSONResponse(status_code=500, content=payload)
    return payload


def _parse_rfc3339(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


@app.post("/reap-idle")
def reap_idle(caller: dict = Depends(get_reap_caller)):
    """Stop the VM when nothing has needed it for VM_IDLE_MINUTES.

    The transcript-worker only fires /stop-jitsi after a meeting.completed
    event; every VM boot without that event (abandoned waiting room, lost
    Pub/Sub delivery, worker outage) used to leak the VM - on, billing, idle -
    until someone stopped it by hand. This endpoint is the level-triggered
    backstop: Cloud Scheduler calls it every ~30 min, and it stops the VM only
    when EVERY guard says nobody needs it.

    Guards, in order (cheap first; each returns {"status": "skipped", why}):
      1. VM not RUNNING            - nothing to do
      2. boot grace                - booted less than VM_IDLE_MINUTES ago
         (protects a user still sitting in the waiting room)
      3. recent waiting-room poll  - /start-jitsi polled within VM_IDLE_MINUTES
      4. live meeting heartbeat    - a meeting_sessions heartbeat within
         VM_HEARTBEAT_GRACE_MINUTES
      5. VM network traffic        - >= VM_ACTIVE_TRAFFIC_BYTES over the last
         VM_IDLE_MINUTES (Cloud Monitoring). Guard 4 alone is forgeable:
         meeting_sessions is browser-writable while its RLS is off, so anyone
         with the anon key could mark a live meeting ended.
    Anyone failing to READ a signal (Supabase down) means "unknown", and
    unknown NEVER stops the VM: fail safe is skip, not stop.

    Auth: Google ID token only (REAPER_AUDIENCE / REAPER_SERVICE_ACCOUNT),
    like /stop-jitsi - a join ticket can never drive a stop.
    """
    now = datetime.now(timezone.utc)
    idle_seconds = cfg.vm_idle_minutes * 60

    try:
        instance = vm_instance()
    except Exception as exc:  # noqa: BLE001 - GCP read failure: skip, retry next tick
        log.warning("reaper: cannot read %s: %s", cfg.instance_name, exc)
        return {"status": "skipped", "reason": "cannot read instance (fail-safe)"}

    status = instance.status or "UNKNOWN"
    if status != "RUNNING":
        return {"status": "skipped", "reason": f"vm {status.lower()}"}

    # Guard 2: boot grace. GCP exposes last_start_timestamp on the instance.
    started = _parse_rfc3339(getattr(instance, "last_start_timestamp", "") or "")
    if started is None:
        return {"status": "skipped", "reason": "no last_start_timestamp (fail-safe)"}
    uptime = (now - started).total_seconds()
    if uptime < idle_seconds:
        return {
            "status": "skipped",
            "reason": f"booted {int(uptime)}s ago (< {int(idle_seconds)}s boot grace)",
        }

    # Guard 3: waiting-room polling. "Never recorded" (manual gcloud start)
    # falls through to the heartbeat guard; "cannot read" fails safe.
    try:
        last_poll = last_start_poll_at()
    except Exception as exc:  # noqa: BLE001
        log.warning("reaper: cannot read jitsi_vm_activity: %s", exc)
        return {"status": "skipped", "reason": "cannot read poll activity (fail-safe)"}
    poll_idle: Optional[float] = None
    if last_poll is not None:
        poll_idle = (now - last_poll).total_seconds()
        if poll_idle < idle_seconds:
            return {
                "status": "skipped",
                "reason": f"waiting-room poll {int(poll_idle)}s ago",
            }

    # Guard 4: someone is in a meeting right now.
    try:
        if has_active_meeting(cfg.heartbeat_grace_minutes):
            return {"status": "skipped", "reason": "active meeting heartbeat"}
    except Exception as exc:  # noqa: BLE001
        log.warning("reaper: cannot read meeting_sessions: %s", exc)
        return {"status": "skipped", "reason": "cannot read meeting sessions (fail-safe)"}

    # Guard 5: traffic - the one signal no browser can fake (see docstring).
    try:
        traffic = vm_network_bytes(str(instance.id), cfg.vm_idle_minutes)
    except Exception as exc:  # noqa: BLE001
        log.warning("reaper: cannot read %s traffic: %s", cfg.instance_name, exc)
        return {"status": "skipped", "reason": "cannot read vm traffic (fail-safe)"}
    if traffic is None:
        return {"status": "skipped", "reason": "no vm traffic samples (fail-safe)"}
    if traffic >= cfg.active_traffic_bytes:
        return {
            "status": "skipped",
            "reason": f"vm traffic {traffic / 1e6:.1f} MB in {int(cfg.vm_idle_minutes)} min",
        }

    # Every guard passed. Stop the billable VM (Cloud Run services stay as-is:
    # scale-to-zero, request-driven).
    try:
        compute_client().stop(
            project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
        )
    except Exception as exc:  # noqa: BLE001 - 5xx so the scheduler log shows it
        log.exception("reaper: stop of %s failed", cfg.instance_name)
        return JSONResponse(
            status_code=500,
            content={"status": "error", "reason": f"stop failed: {exc}"},
        )

    log.info(
        "reaper: stopped %s (up %ds, %s)",
        cfg.instance_name,
        int(uptime),
        f"last poll {int(poll_idle)}s ago" if poll_idle is not None else "no poll ever recorded",
    )
    return {
        "status": "stopped",
        "uptime_seconds": int(uptime),
        "poll_idle_seconds": int(poll_idle) if poll_idle is not None else None,
        "traffic_bytes": traffic,
    }


@app.get("/status")
def status(current_user: Optional[dict] = Depends(get_current_user)) -> dict[str, Any]:
    """Read-only view of every component (no side effects beyond probes). For debugging.

    Authentication: same as /start-jitsi. The probes wake the paid services.
    """
    if current_user is None:
        raise HTTPException(status_code=401, detail="Authentication required")

    components: dict[str, dict[str, str]] = {}
    try:
        vm = vm_status()
        if vm == "RUNNING" and probe_jitsi_public():
            components["jvb"] = {"state": "RUNNING", "https": "ready"}
        elif vm == "RUNNING":
            components["jvb"] = {"state": "RUNNING", "https": "not-ready"}
        else:
            components["jvb"] = {"state": vm}
    except Exception as exc:  # noqa: BLE001
        components["jvb"] = {"state": "error", "detail": str(exc)}

    for key, name, health_path, require_ok in (
        ("stt", cfg.stt_service_name, "/ready", True),
        ("proxy", cfg.proxy_service_name, "/health", False),
    ):
        try:
            url = _service_url(name)
            healthy = bool(url) and probe(
                url, health_path, cfg.stt_probe_timeout_seconds, require_status_ok=require_ok
            )
            components[key] = {
                "state": "ready" if healthy else "cold-or-starting",
                "url": url,
            }
        except Exception as exc:  # noqa: BLE001
            components[key] = {"state": "error", "detail": str(exc)}

    return {
        "jitsi_public_url": cfg.jitsi_public_url,
        "components": components,
    }
