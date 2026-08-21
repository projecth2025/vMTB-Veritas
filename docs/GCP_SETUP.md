# GCP Setup — step-by-step (beginner friendly)

This guide walks through deploying the transcription pipeline to Google Cloud
from scratch. It assumes basic familiarity with the Google Cloud Console but no
deep GCP knowledge. Commands use `gcloud`; you can do almost everything in the
Console UI instead.

> Use the same project for everything so IAM and networking stay simple. For the
> MVP all three services (proxy, stt-service, transcript-worker) talk to each
> other over internal Cloud Run URLs and only the proxy needs to be reachable
> from the JVB VM.

---

## 0. Prerequisites

- A Google Cloud account with billing enabled.
- `gcloud` installed and authenticated:
  ```bash
  gcloud auth login
  gcloud config set project YOUR_PROJECT_ID
  ```
- The existing Jitsi VM (`jitsi-vm`, zone `asia-south1-c`) managed by
  `jitsi-activation-backend`, plus a Supabase project.

---

## 1. Enable the APIs (one time)

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  pubsub.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

---

## 2. Artifact Registry (container images)

```bash
gcloud artifacts repositories create vmtb-services \
  --repository-format=docker \
  --location=asia-south1
gcloud auth configure-docker asia-south1-docker.pkg.dev
```

For the STT GPU image, use a region that offers L4 GPUs on Cloud Run
(see §6). Pick the same region for all resources to keep it simple.

---

## 3. Cloud Storage (transcript artifacts)

```bash
gcloud storage buckets create gs://vmtb-transcripts \
  --location=asia-south1 \
  --uniform-bucket-level-access
```

No public access. Only the transcript-worker's service account will write here.

---

## 4. Pub/Sub (meeting completion events)

```bash
gcloud pubsub topics create meeting-transcripts
gcloud pubsub subscriptions create meeting-transcripts-worker \
  --topic=meeting-transcripts \
  --push-endpoint=REPLACE_WITH_WORKER_URL_AFTER_STEP_8 \
  --push-auth-service-account=YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --ack-deadline=60
```

You will fill in the real push endpoint in step 8 and add the auth token then.
Alternatively create the subscription through the Console after the worker is up.

---

## 5. Service accounts & secrets

Create one service account that both the proxy and the worker use, or two
separate ones for least privilege. Example (shared):

```bash
gcloud iam service-accounts create vmtb-transcription-sa \
  --display-name="vMTB transcription services"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# transcript-worker only needs to write artifacts + read/write Supabase:
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### Secrets (Secret Manager)

Store anything sensitive in Secret Manager and mount as env vars on Cloud Run:

```bash
printf '%s' 'SERVICE_ROLE_KEY' | \
  gcloud secrets create supabase-service-role-key \
    --data-file=- --replication-policy=automatic

printf '%s' 'LLM_API_KEY' | \
  gcloud secrets create llm-api-key --data-file=- --replication-policy=automatic

gcloud secrets add-iam-policy-binding supabase-service-role-key \
  --member="serviceAccount:vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Repeat the IAM binding for `llm-api-key`.

---

## 6. Build and deploy the STT service (GPU)

Cloud Run supports GPUs (e.g. L4) but only in specific regions and with a GPU
quota increase. First request L4 quota in the region you choose:

1. Console → IAM & Admin → **Quotas** → filter `L4` → select your region →
   **Edit Quotas** → request an increase (e.g. 1 GPU).
2. Cloud Run GPU instances require the `run.googleapis.com` GPU service:
   ```bash
   gcloud services enable run.googleapis.com
   ```

Build the image **with the model baked in** (done at build time; the image
contains faster-whisper + the `medium` model, so instances start fast and never
download models at runtime):

```bash
cd stt-service
gcloud builds submit --tag \
  asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/stt-service:medium \
  --build-arg=STT_DEVICE=gpu --build-arg=STT_MODEL=medium .
```

> Building with `STT_DEVICE=gpu` adds the CUDA runtime wheels via pip. The model
> bake step always runs on CPU (`compute_type=int8`) so it works without a GPU.

Deploy:

```bash
gcloud run deploy stt-service \
  --image=asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/stt-service:medium \
  --region=REGION_WITH_L4 \
  --gpu=1 --gpu-type=nvidia-l4 \
  --memory=16Gi --cpu=4 \
  --no-allow-unauthenticated \
  --service-account=vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=STT_MODEL=medium,STT_DEVICE=cuda,STT_COMPUTE_TYPE=float16 \
  --min-instances=0 --max-instances=2 --concurrency=1
```

`concurrency=1` because transcription is serialised per instance (see
`stt-service/README.md`). Set `--min-instances=0` to save cost; accept the cold
start during a meeting (or keep one warm instance for clinical reliability).

---

## 7. Deploy the opus-transcriber-proxy

```bash
cd opus-transcriber-proxy
gcloud builds submit --tag \
  asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/opus-transcriber-proxy .

gcloud run deploy opus-transcriber-proxy \
  --image=asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/opus-transcriber-proxy \
  --region=asia-south1 \
  --no-allow-unauthenticated \
  --service-account=vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=PROVIDER=self-hosted,STT_SAMPLE_RATE=16000,STT_CHUNK_MS=60 \
  --set-env-vars=STT_WS_URL=https://stt-service-XXXXXX-uc.a.run.app/client/ws/speech \
  --set-env-vars=GCP_PROJECT_ID=YOUR_PROJECT_ID,PUBSUB_TOPIC=meeting-transcripts \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest \
  --min-instances=0 --max-instances=10 --concurrency=50
```

- `STT_WS_URL` is the internal URL of `stt-service` (you can find it with
  `gcloud run services describe stt-service --region=... --format='value(status.url)'`).
  Internal calls between Cloud Run services on the same project are
  authenticated automatically with the service account.
- The JVB VM will connect to this service, so its **public** URL must be
  reachable from the VM. Keep `--no-allow-unauthenticated`; the JVB connects as
  a WebSocket client, which is fine — clients don't need IAM for WebSocket
  upgrade if invocations are allowed. For the MVP you can also set
  `--allow-unauthenticated` and rely on the `sessionId` guard; prefer the
  Cloud Run invocation policy once tested.

---

## 8. Deploy the transcript-worker

```bash
cd transcript-worker
gcloud builds submit --tag \
  asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/transcript-worker .

gcloud run deploy transcript-worker \
  --image=asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/vmtb-services/transcript-worker \
  --region=asia-south1 \
  --no-allow-unauthenticated \
  --service-account=vmtb-transcription-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=GCS_BUCKET=vmtb-transcripts,GCP_PROJECT_ID=YOUR_PROJECT_ID,LLM_PROVIDER=openai \
  --set-env-vars=LLM_BASE_URL=https://api.openai.com/v1,LLM_MODEL=gpt-4o-mini \
  --set-secrets=SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest \
  --set-secrets=LLM_API_KEY=llm-api-key:latest \
  --min-instances=0 --max-instances=5
```

Then wire up Pub/Sub push to this service **with a token**:

1. Create a token (random string) and set it as `PUBSUB_PUSH_TOKEN` on the
   worker deployment:
   ```bash
   gcloud run services update transcript-worker \
     --region=asia-south1 \
     --update-env-vars=PUBSUB_PUSH_TOKEN=RANDOM_TOKEN
   ```
2. Update the subscription with the public worker URL and the same token:
   ```bash
   gcloud pubsub subscriptions update meeting-transcripts-worker \
     --push-endpoint=https://transcript-worker-XXXXXX-uc.a.run.app/pubsub/push \
     --push-auth-token=RANDOM_TOKEN
   ```

---

## 9. Verify

Check each service's `/health`:

```bash
gcloud run services describe opus-transcriber-proxy --region=asia-south1 --format='value(status.url)'
# then curl -s <url>/health  (may need `gcloud auth print-access-token` for non-public)
```

End-to-end test without a real meeting (from any machine that can reach the
proxy URL):

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("wss://<proxy-url>/transcribe?sessionId=smoke-room&provider=dummy");
ws.on("open", () => {
  ws.send(JSON.stringify({event:"ping",id:1}));
  ws.send(JSON.stringify({event:"start",start:{tag:"p1"}}));
  ws.send(JSON.stringify({event:"media",media:{tag:"p1",chunk:0,timestamp:0,payload:Buffer.alloc(8000).toString("base64")}}));
});
ws.on("message", (m) => { console.log(m.toString()); });
'
```

With `provider=dummy` you should see a `transcription-result`. In Supabase,
`meeting_transcripts` gets a row and `meeting_transcript_segments` gets dummy
final segments. Run the same with the real `self-hosted` provider and a real
JVB session for the full flow.

---

## 10. Common gotchas

- **GPU quota**: the most common blocker. Request it early in your chosen region.
- **Region mismatch**: STT GPU region and the other services should agree; the
  proxy's `STT_WS_URL` must be the deployed STT URL.
- **Secret Manager access**: if Cloud Run shows "permission denied" for a secret,
  re-add the `roles/secretmanager.secretAccessor` binding for the service account.
- **Concurrency**: keep STT at `concurrency=1`; raise replicas for more streams.
- **Cost**: GPU instances and `--min-instances>0` cost money. For a clinic MVP,
  use `--min-instances=0` and accept a cold start on the first meeting.
- **WebSocket timeouts**: Cloud Run's default idle timeout is ~15 min; Jitsi
  meetings can run hours. Set `--timeout=3600` (max 60 min for Cloud Run) and
  rely on the proxy/STT heartbeat (`STT_MAX_RUN_GAP_SECONDS`) rather than the
  platform for liveness.