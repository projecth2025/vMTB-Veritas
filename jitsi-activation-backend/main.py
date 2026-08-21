"""vMTB meeting infrastructure activation service.

Brings up (and tears down) every billable component a meeting needs:

  - ``jitsi-vm``            Compute Engine VM running JVB/Prosody/Jicofo
  - ``stt-service``         Cloud Run GPU service, scale-to-zero
  - ``opus-transcriber-proxy``  Cloud Run service, scale-to-zero

Scale-to-zero Cloud Run services are "woken" by raising their
``min_instance_count`` from 0 to 1 and are considered ready once their health
endpoint answers. Stopping lowers it back to 0 so nothing bills while idle.

``POST /start-jitsi`` is polled by jitsi-frontend every few seconds until it
returns ``{"status": "already_running"}``, which means ALL components are up.
The endpoint is idempotent: each poll re-checks state, only issues start
requests for components that are not yet up, and never blocks for long.

Credentials come from Application Default Credentials (the service account
attached to this Cloud Run service). For local development you can instead set
``GCP_SERVICE_ACCOUNT_JSON`` to a full service-account JSON blob.
"""

import json
import logging
import os
import time
from typing import Any

import google.auth
import httpx
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.cloud import compute_v1
from google.cloud import run_v2
from google.oauth2 import id_token as google_id_token
from google.oauth2 import service_account
from google.protobuf.field_mask_pb2 import FieldMask

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
        "https://vmtb.netlify.app",
        "https://www.vmtb.in",
        "https://server.vmtb.in",
        "https://meet.vmtb.in",
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
        # How long to remember that a wake patch was already issued, so rapid
        # polling does not create a new revision on every call.
        self.wake_guard_seconds = float(os.environ.get("WAKE_GUARD_SECONDS", "30"))
        # Per-request timeout for health probes.
        self.probe_timeout_seconds = float(os.environ.get("PROBE_TIMEOUT_SECONDS", "6"))


cfg = Config()

# ---------------------------------------------------------------------------
# Lazy GCP clients (initialised on first use so /health works without creds)
# ---------------------------------------------------------------------------

_compute_client: compute_v1.InstancesClient | None = None
_run_client: run_v2.ServicesClient | None = None

# Guards against issuing duplicate wake/sleep patches while one is still being
# applied by Cloud Run (polling happens every ~5s).
_last_wake_at: dict[str, float] = {}
_last_sleep_at: dict[str, float] = {}


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


def run_client() -> run_v2.ServicesClient:
    global _run_client
    if _run_client is None:
        _run_client = run_v2.ServicesClient(credentials=_credentials())
    return _run_client


def _service_resource_name(service_name: str) -> str:
    return f"projects/{cfg.project_id}/locations/{cfg.region}/services/{service_name}"


def get_run_service(service_name: str) -> run_v2.Service:
    return run_client().get_service(name=_service_resource_name(service_name))


def min_instances(service: run_v2.Service) -> int:
    scaling = getattr(service, "scaling", None)
    count = getattr(scaling, "min_instance_count", 0) if scaling else 0
    return count or 0


def _patch_min_instances(service_name: str, target: int) -> bool:
    """Set min_instance_count on a Cloud Run service.

    Returns True when a patch was actually issued. A time guard prevents
    hammering the API (and creating revisions) while polls arrive every 5s.
    """
    guard = _last_wake_at if target >= 1 else _last_sleep_at
    last = guard.get(service_name, 0.0)
    if time.monotonic() - last < cfg.wake_guard_seconds:
        log.info("%s: %s patch recently issued, skipping", service_name,
                 "wake" if target >= 1 else "sleep")
        return False

    service = get_run_service(service_name)
    if min_instances(service) == target:
        return False

    service.scaling.min_instance_count = target
    run_client().update_service(
        service=service,
        update_mask=FieldMask(paths=["scaling"]),
    )
    guard[service_name] = time.monotonic()
    log.info("%s: min_instances -> %d", service_name, target)
    return True


def probe(base_url: str, path: str) -> bool:
    """GET a health endpoint, authenticating with an ID token when possible."""
    url = base_url.rstrip("/") + path
    headers: dict[str, str] = {}
    try:
        token = google_id_token.fetch_id_token(GoogleAuthRequest(), base_url)
        if token:
            headers["Authorization"] = f"Bearer {token}"
    except Exception as exc:  # noqa: BLE001 - fall back to unauthenticated
        log.debug("id token fetch failed for %s (%s); trying unauthenticated", base_url, exc)

    try:
        resp = httpx.get(url, headers=headers, timeout=cfg.probe_timeout_seconds)
        ok = resp.status_code == 200
        log.debug("probe %s -> %s", url, resp.status_code)
        return ok
    except Exception as exc:  # noqa: BLE001 - probing must never raise
        log.info("probe %s failed: %s", url, exc)
        return False


def vm_status() -> str:
    instance = compute_client().get(
        project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
    )
    return instance.status or "UNKNOWN"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
@app.head("/")
def health_check() -> Response:
    """Lightweight health check for uptime monitors and platform probes."""
    return Response(content="OK", status_code=200)


@app.post("/start-jitsi")
def start_jitsi() -> dict[str, Any]:
    """Bring every meeting component up. Safe to call repeatedly.

    Returns ``already_running`` only when the VM is RUNNING **and** both Cloud
    Run services answer their health endpoints; otherwise ``starting``.
    """
    components: dict[str, dict[str, str]] = {}

    # 1. Jitsi VM (JVB / Prosody / Jicofo)
    try:
        status = vm_status()
        if status == "RUNNING":
            components["jvb"] = {"state": "ready"}
        else:
            log.info("%s: starting (status=%s)", cfg.instance_name, status)
            compute_client().start(
                project=cfg.project_id, zone=cfg.zone, instance=cfg.instance_name
            )
            components["jvb"] = {"state": "starting", "detail": f"vm {status}"}
    except Exception as exc:  # noqa: BLE001 - report per-component errors
        log.exception("jvb start check failed")
        components["jvb"] = {"state": "error", "detail": str(exc)}

    # 2. Scale-to-zero Cloud Run services
    services = (
        ("stt", cfg.stt_service_name, "/ready"),
        ("proxy", cfg.proxy_service_name, "/health"),
    )
    for key, name, health_path in services:
        try:
            service = get_run_service(name)
            if min_instances(service) < 1:
                _patch_min_instances(name, 1)
            url = service.uri or ""
            state = "ready" if (url and probe(url, health_path)) else "starting"
            components[key] = {"state": state}
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
def stop_jitsi() -> dict[str, Any]:
    """Tear everything down so idle components stop billing."""
    components: dict[str, dict[str, str]] = {}

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

    for key, name in (("stt", cfg.stt_service_name), ("proxy", cfg.proxy_service_name)):
        try:
            patched = _patch_min_instances(name, 0)
            components[key] = {
                "state": "stopping" if patched else "stopped",
            }
        except Exception as exc:  # noqa: BLE001
            log.exception("%s sleep failed", name)
            components[key] = {"state": "error", "detail": str(exc)}

    all_down = all(c["state"] in ("stopped",) for c in components.values())
    payload = {
        "status": "already_stopped" if all_down else "stopping",
        "components": components,
    }
    log.info("/stop-jitsi -> %s %s", payload["status"], components)
    return payload


@app.get("/status")
def status() -> dict[str, Any]:
    """Read-only view of every component (no side effects). For debugging."""
    components: dict[str, dict[str, str]] = {}
    try:
        components["jvb"] = {"state": vm_status()}
    except Exception as exc:  # noqa: BLE001
        components["jvb"] = {"state": "error", "detail": str(exc)}

    for key, name, health_path in (
        ("stt", cfg.stt_service_name, "/ready"),
        ("proxy", cfg.proxy_service_name, "/health"),
    ):
        try:
            service = get_run_service(name)
            warm = min_instances(service) >= 1
            healthy = warm and probe(service.uri or "", health_path)
            components[key] = {
                "state": "ready" if healthy else ("warm" if warm else "cold"),
                "url": service.uri or "",
            }
        except Exception as exc:  # noqa: BLE001
            components[key] = {"state": "error", "detail": str(exc)}

    return {"project": cfg.project_id, "region": cfg.region, "components": components}
