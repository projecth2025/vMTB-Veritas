# vMTB Deployment Guide (GCP + GitHub Actions)

Deploy every backend service to Google Cloud, trigger builds/deploys with
buttons in the GitHub **Actions** tab, then test the whole application
end-to-end.

**Region layout** (chosen for cost + GPU availability):

| Component | Where | Why |
|---|---|---|
| `stt-service` (GPU Whisper) | Cloud Run, `asia-southeast1` (Singapore) | L4 GPUs available; `asia-south1` L4 is invite-only |
| `opus-transcriber-proxy` | Cloud Run, `asia-southeast1` | co-located with STT (streams audio to it) |
| `transcript-worker` | Cloud Run, `asia-southeast1` | async post-meeting job |
| `jitsi-activation-backend` | Cloud Run, `asia-southeast1` | wakes/stops everything below |
| `jitsi-vm` (JVB/Prosody/Jicofo) | Compute Engine, `asia-south1-c` (Mumbai) | low media latency for Indian users |
| `main/` app | Render (unchanged) | existing deployment |
| `jitsi-frontend/` | Vercel (`server.vmtb.in`) | existing deployment |

Everything is **scale-to-zero**: STT and proxy run with `--min-instances 0`
and only bill while woken up by the activation backend for a meeting.

```
 Start Meeting (main app)
   └─> server.vmtb.in (jitsi-frontend) ──polls──> POST /start-jitsi (activation backend)
                                                    ├─ starts jitsi-vm (Compute Engine)
                                                    ├─ wakes stt-service (min-instances 0→1)
                                                    └─ wakes opus-transcriber-proxy (0→1)
   poll returns already_running only when ALL THREE are healthy
   └─> browser joins meet.vmtb.in/<room>
        JVB ──WSS──> proxy ──WSS(+ID token)──> stt-service ──finals──> Supabase
        meeting ends ──> Pub/Sub meeting.completed ──> transcript-worker
                         claim → GCS artifacts → Mistral MoM → COMPLETED
```

---

## 0. Prerequisites

- A GCP project with billing enabled. Note your **project id**
  (`gcloud config get-value project`) and **project number**
  (`gcloud projects describe PROJECT_ID --format='value(projectNumber)'`).
- `gcloud` installed locally and authenticated:
  ```bash
  gcloud auth login
  gcloud config set project YOUR_PROJECT_ID
  ```
- Your GitHub fork/repo name (e.g. `youruser/vMTB-Veritas`).
- A [Mistral](https://console.mistral.ai/) account (free tier is fine to start).
- Supabase project credentials (URL + anon key + **service role key**).

---

## 1. One-time GCP setup

Copy-paste each block, replacing `YOUR_PROJECT_ID` / `YOUR_GH_USER`.

### 1.1 Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  compute.googleapis.com \
  artifactregistry.googleapis.com \
  pubsub.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com
```

### 1.2 Artifact Registry (container images)

```bash
gcloud artifacts repositories create vmtb-services \
  --repository-format=docker --location=asia-southeast1
```

### 1.3 Storage bucket (transcript artifacts)

```bash
gcloud storage buckets create gs://vmtb-transcripts \
  --location=asia-southeast1 --uniform-bucket-level-access
```

### 1.4 Pub/Sub topic

```bash
gcloud pubsub topics create meeting-transcripts
```

(The push subscription is created after the worker is deployed — §3.4.)

### 1.5 Service accounts & permissions

```bash
# Runtime SA for stt-service, proxy, transcript-worker
gcloud iam service-accounts create vmtb-services \
  --display-name="vMTB transcription services"

# Runtime SA for the activation backend
gcloud iam service-accounts create vmtb-activator \
  --display-name="vMTB meeting activator"

# CI/CD deployer (used by GitHub Actions via WIF)
gcloud iam service-accounts create vmtb-deployer \
  --display-name="vMTB CI deployer"

PROJECT_ID=YOUR_PROJECT_ID

# --- vmtb-services: invoke other services, write artifacts, read secrets ---
for ROLE in roles/run.invoker roles/storage.objectAdmin roles/secretmanager.secretAccessor roles/pubsub.publisher; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done

# --- vmtb-activator: start/stop the VM, wake/sleep Cloud Run services ---
for ROLE in roles/compute.instanceAdmin.v1 roles/run.developer roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done
# Patching a service that runs as vmtb-services requires actAs on it:
gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
  --member="serviceAccount:vmtb-activator@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# --- vmtb-deployer: what GitHub Actions may do ---
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer roles/cloudbuild.builds.builder roles/storage.objectAdmin roles/secretmanager.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" --role="$ROLE"
done
```

### 1.6 Secrets (Secret Manager)

Collect these values first:

| Secret Manager name | Value |
|---|---|
| `supabase-url` | `https://xxxx.supabase.co` |
| `supabase-service-role-key` | service role key (**secret**, never the anon key) |
| `llm-api-key` | Mistral API key (§4) |
| `pubsub-push-token` | any long random string you invent |

```bash
printf '%s' 'https://xxxx.supabase.co' | gcloud secrets create supabase-url --data-file=- --replication-policy=automatic
printf '%s' 'SUPABASE_SERVICE_ROLE_KEY' | gcloud secrets create supabase-service-role-key --data-file=- --replication-policy=automatic
printf '%s' 'MISTRAL_API_KEY'          | gcloud secrets create llm-api-key --data-file=- --replication-policy=automatic
openssl rand -hex 24 | gcloud secrets create pubsub-push-token --data-file=- --replication-policy=automatic

# Only vmtb-services reads them at runtime:
for SECRET in supabase-url supabase-service-role-key llm-api-key pubsub-push-token; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:vmtb-services@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 1.7 GPU quota (do this early — approval takes time)

Console → **IAM & Admin → Quotas** → filter: `GPUS_ALL_MODEL_ZONES` (and
`NVIDIA_L4_GPUS`) in `asia-southeast1` → request an increase to **1**.
Without quota the STT deploy fails with a GPU quota error.

### 1.8 GitHub Actions authentication (Workload Identity Federation)

No long-lived keys stored in GitHub — GitHub's OIDC token is exchanged for
GCP credentials.

```bash
PROJECT_NUMBER=YOUR_PROJECT_NUMBER
GH_REPO="YOUR_GH_USER/vMTB-Veritas"

gcloud iam workload-identity-pools create github-pool \
  --location=global --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GH_REPO}'"

gcloud iam service-accounts add-iam-policy-binding \
  "vmtb-deployer@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${GH_REPO}"
```

Now add three secrets in GitHub: **Settings → Secrets and variables →
Actions → New repository secret**

| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project id |
| `GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_DEPLOY_SA` | `vmtb-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com` |

---

## 2. Supabase schema

Apply `main/supabase/migrations/20260820_meeting_transcripts.sql` once:
Supabase Dashboard → **SQL Editor** → paste the file contents → **Run**.
This creates `meeting_transcripts`, `meeting_transcript_segments`, the state
RPCs, RLS policies and adds segments to the realtime publication.

---

## 3. Deploy the services (GitHub buttons)

Push this branch to GitHub, then open the **Actions** tab. You will find one
workflow per service — click it, press **Run workflow**, keep the default
image tag. Deploy in this order (later ones depend on earlier ones):

1. **Deploy stt-service** — slowest first build (~15–25 min: CUDA wheels +
   baked Whisper `medium` model).
2. **Deploy opus-transcriber-proxy** — auto-wires `STT_WS_URL` from step 1.
3. **Deploy transcript-worker** — wires Mistral + secrets.
4. **Deploy jitsi-activation-backend** — wires VM + both services by name.

Each workflow prints the service URL in its log (also visible via
`gcloud run services list`). Note down:

```bash
gcloud run services list --project YOUR_PROJECT_ID
```

### 3.4 Wire Pub/Sub push to the worker (one-time, after step 3)

```bash
WORKER_URL=$(gcloud run services describe transcript-worker \
  --project YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')
PUSH_TOKEN=$(gcloud secrets versions access latest --secret=pubsub-push-token)

gcloud pubsub subscriptions create meeting-transcripts-worker \
  --topic=meeting-transcripts \
  --push-endpoint="${WORKER_URL}/pubsub/push" \
  --push-auth-service-account="vmtb-services@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --push-auth-token="$PUSH_TOKEN" \
  --ack-deadline=60
```

The `push-auth-service-account` gives Pub/Sub an ID token so the worker's
`--no-allow-unauthenticated` policy accepts the delivery; the random
`push-auth-token` is a second layer checked by the worker itself.

---

## 4. Mistral setup (Minutes-of-Meeting)

1. Sign up at <https://console.mistral.ai/> → **API Keys** → create key.
2. Store it: `gcloud secrets versions add llm-api-key --data-file=- <<< 'YOUR_KEY'`
   (or re-run the §1.6 command with the real key before first deploy).
3. The worker is already configured (see `.github/workflows/deploy-transcript-worker.yml`):
   - `LLM_PROVIDER=mistral` (any value except `none` enables MoM)
   - `LLM_BASE_URL=https://api.mistral.ai/v1` (OpenAI-compatible)
   - `LLM_MODEL=mistral-small-latest` (cheap + good; use
     `mistral-large-latest` for higher quality)
4. Free tier rate limits are handled: `generateMom` retries 429/5xx twice
   with backoff (`transcript-worker/src/llm.ts`).

Test MoM generation standalone:

```bash
curl https://api.mistral.ai/v1/chat/completions \
  -H "Authorization: Bearer $MISTRAL_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"mistral-small-latest","response_format":{"type":"json_object"},
       "messages":[{"role":"user","content":"Return {\"summary\":\"ok\"}"}]}'
```

---

## 5. Jitsi VM (`jitsi-vm`)

The VM must exist in `asia-south1-c` (the activation backend starts/stops it
by name). If your old VM still exists, only do §5.2. If you scrapped it,
create a fresh one first (Ubuntu 22.04, e2-standard-4, ports 80/443/10000),
install Jitsi Meet following the official quickstart
(<https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-quickstart>),
point DNS `meet.vmtb.in` at its IP, and install TLS via
`/usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh`.

### 5.1 Enable transcription (bridge-based)

Follow `docs/JITSI_INTEGRATION.md`. Summary of the three edits on the VM:

```lua
-- /etc/prosody/conf.avail/<your-vhost>.cfg.lua  (inside the MUC component)
muc_room_metadata = {
    ["org.jitsi.meet"] = { transcription = { enabled = true } },
}
```

```
# /etc/jicofo/jicofo.conf
jicofo {
  transcription {
    url-template = "wss://PROXY_PUBLIC_URL/transcribe?sessionId={{MEETING_ID}}&sendBack=true"
  }
}
```

```js
// /etc/jitsi/meet/meet.vmtb.in-config.js
transcription: { enabled: true },
```

Then `sudo systemctl restart prosody jicofo nginx`. Replace
`PROXY_PUBLIC_URL` with the proxy URL from §3.

### 5.2 Verify the activation backend can control the VM

```bash
ACT_URL=$(gcloud run services describe jitsi-activation-backend \
  --project YOUR_PROJECT_ID --region asia-southeast1 --format 'value(status.url)')

curl -s "$ACT_URL/status" | python3 -m json.tool   # read-only view
curl -s -X POST "$ACT_URL/start-jitsi"             # repeat until all "ready"
curl -s -X POST "$ACT_URL/stop-jitsi"              # tear everything down
```

`/start-jitsi` returns `{"status":"already_running"}` only when the VM is
RUNNING **and** both Cloud Run services answer their health endpoints.

---

## 6. Frontends

### 6.1 `main/` on Render

Set environment variables (Render → service → Environment):

| Var | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | anon key |
| `VITE_JITSI_BACKEND_URL` | activation backend URL (from §5.2) |
| `VITE_SERVER_LOADER_URL` | `https://server.vmtb.in` (jitsi-frontend) |

Redeploy after changing env vars.

### 6.2 `jitsi-frontend/` on Vercel (`server.vmtb.in`)

| Var | Value |
|---|---|
| `VITE_JITSI_BACKEND_URL` | activation backend URL |
| `VITE_JITSI_DOMAIN` | `meet.vmtb.in` |
| `VITE_MAIN_APP_URL` | your main app URL |
| `VITE_SUPABASE_URL` | your Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | anon key |

---

## 7. End-to-end test

1. **Cold check**: `curl $ACT_URL/status` → jvb `TERMINATED`, stt/proxy `cold`.
2. **Start a meeting**: main app → MTB → *Meeting* → *Start Meeting*. The
   loader page polls `/start-jitsi`; expect **1–3 minutes** (VM boot + GPU
   allocation + model load) before the room opens.
3. **Transcribe**: in the meeting, enable *Record/Transcribe* from the
   reactions/menu, speak. Captions should appear (`sendBack=true`).
4. **Segments land**: Supabase → Table Editor →
   `meeting_transcript_segments` shows FINAL rows for the meeting id.
5. **End the meeting**: leave/end for all participants. Within ~a minute the
   worker processes the `meeting.completed` event:
   - `meeting_transcripts.status` → `COMPLETED`
   - `gs://vmtb-transcripts/meetings/<meeting_id>/transcript/transcript-v1.{json,txt}`
   - `minutes_of_meeting` column populated by Mistral (JSON with summary /
     decisions / action items).
6. **Tear down**: `curl -X POST $ACT_URL/stop-jitsi` → confirm `/status`
   shows everything stopped/cold. **Do this after every test session** —
   the warm GPU bills ~$0.80/hr.

Smoke-test without a real meeting (dummy provider, no GPU needed):

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("wss://PROXY_URL/transcribe?sessionId=smoke-room&provider=dummy");
ws.on("open", () => ws.send(JSON.stringify({event:"ping",id:1})));
ws.on("message", (m) => console.log(m.toString()));
'
```

---

## 8. Keeping costs near zero between meetings

- Everything deploys with `--min-instances 0`: idle Cloud Run services are free.
- The GPU instance only exists while woken (`min-instances 0→1` by
  `/start-jitsi`) — it bills roughly **$0.70–1.00/hr** while warm.
- The Jitsi VM bills while RUNNING (~e2-standard-4 price).
- **Always stop after testing**: `curl -X POST $ACT_URL/stop-jitsi`.
- Safety net — auto-stop every night (Cloud Scheduler):
  ```bash
  gcloud scheduler jobs create http vmtb-nightly-stop \
    --schedule="30 18 * * *" --time-zone="Asia/Kolkata" \  # 00:00 IST
    --uri="$ACT_URL/stop-jitsi" --http-method=POST
  ```

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| STT deploy fails with GPU/quota error | §1.7 quota not granted yet, or wrong region (must be `asia-southeast1`) |
| Meeting stuck on loader ("Server starting…") | `curl $ACT_URL/status` — see which component isn't ready; check Cloud Run logs of that service |
| `/start-jitsi` components show `error` | activation backend lacks IAM (re-run §1.5 bindings); check its Cloud Run logs |
| Proxy logs show STT connect failures (403) | `STT_USE_ID_TOKEN=true` missing on proxy, or `vmtb-services` lacks `roles/run.invoker` |
| No captions in meeting | Jicofo `url-template` wrong / Prosody metadata missing / transcription toggle off (§5.1) |
| Segments never appear in Supabase | proxy `PERSISTENCE=supabase` + secrets correct? Check proxy logs for store errors |
| Worker never runs | push subscription missing/wrong URL/token (§3.4); check `meeting_transcripts.status` stays `PENDING` |
| Worker marks meeting FAILED with LLM error | invalid/expired Mistral key in `llm-api-key` secret; fix key, redeploy worker, re-trigger by replaying the Pub/Sub message |
| WebSocket drops at exactly 60 min | Cloud Run hard request timeout cap; the proxy auto-reconnects to STT, JVB reconnects to proxy — acceptable for MVP |
| CORS error in browser console | add the frontend origin to `CORS_ORIGINS` env of the activation backend and redeploy |
