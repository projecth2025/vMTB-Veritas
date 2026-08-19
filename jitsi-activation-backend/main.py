import json
import os
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import compute_v1
from google.oauth2 import service_account

app = FastAPI()

# Add CORS middleware - must be before route definitions
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "https://vmtb.netlify.app",
        "https://www.vmtb.in",
        "https://server.vmtb.in",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ID = "project-d62706c7-1f50-4a3c-870"
ZONE = "asia-south1-c"
INSTANCE_NAME = "jitsi-vm"

# Load credentials from environment variable
service_account_info = json.loads(
    os.environ["GCP_SERVICE_ACCOUNT_JSON"]
)

credentials = service_account.Credentials.from_service_account_info(
    service_account_info
)

client = compute_v1.InstancesClient(credentials=credentials)


# Health check endpoint for UptimeRobot and Render
@app.get("/")
@app.head("/")
def health_check():
    """
    Lightweight health check endpoint for uptime monitoring.
    No authentication, no VM logic - just returns 200 OK.
    Used by UptimeRobot and Render health checks.
    """
    return Response(content="OK", status_code=200)


@app.post("/start-jitsi")
def start_jitsi():
    instance = client.get(
        project=PROJECT_ID,
        zone=ZONE,
        instance=INSTANCE_NAME
    )

    if instance.status == "RUNNING":
        return {"status": "already_running"}

    client.start(
        project=PROJECT_ID,
        zone=ZONE,
        instance=INSTANCE_NAME
    )

    return {"status": "starting"}


@app.post("/stop-jitsi")
def stop_jitsi():
    instance = client.get(
        project=PROJECT_ID,
        zone=ZONE,
        instance=INSTANCE_NAME
    )

    if instance.status == "TERMINATED":
        return {"status": "already_stopped"}

    client.stop(
        project=PROJECT_ID,
        zone=ZONE,
        instance=INSTANCE_NAME
    )

    return {"status": "stopping"}
