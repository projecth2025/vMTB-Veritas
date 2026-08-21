# Local Development Guide (no Docker)

Run the entire bridge-based meeting-transcription pipeline on one machine without
Docker: `opus-transcriber-proxy` → `stt-service` → Supabase → Pub/Sub →
`transcript-worker` → GCS. Uses real GCS, real Pub/Sub and the real Supabase
project, with a simulated JVB talking to the proxy.

## Prerequisites

- Node.js 20+ and npm
- `uv` (for `stt-service`) — `uv run` keeps the service in its own `.venv`
- `gcloud` CLI, authenticated (`gcloud auth login`), with the GCP project set:
  ```bash
  gcloud auth login
  gcloud config set project vmtb-new
  ```
- A Supabase project (used here: `togobilqdevoyijxrexc`)

---

## 1. Apply the Supabase migration (one-time)

The schema lives in `main/supabase/migrations/20260820_meeting_transcripts.sql`.
It creates `meeting_transcripts`, `meeting_transcript_segments`, the RPCs
(`ensure_meeting_transcript`, `claim_meeting_transcript`,
`complete_meeting_transcript`, `fail_meeting_transcript`) and realtime
publication.

**Option A — SQL Editor (simplest):** Supabase Dashboard → your project → SQL
Editor → paste the whole file → Run.

**Option B — Management API** (needs a Supabase personal access token, Settings →
Access Tokens):

```bash
curl -sS -X POST \
  "https://api.supabase.com/v1/projects/togobilqdevoyijxrexc/database/query" \
  -H "Authorization: Bearer $SUPABASE_PAT" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(jq -Rs . < main/supabase/migrations/20260820_meeting_transcripts.sql)}"
```

You need the **service role key** too (Dashboard → Project Settings → API →
`service_role` key). This key has full DB access — never commit it or expose it
in the frontend. You will paste it into the proxy and worker `.env` files below.

---

## 2. GCP setup (one-time)

Run these once per project:

```bash
# Storage bucket for transcript artifacts
gcloud storage buckets create gs://vmtb-new-transcripts \
  --location=asia-south1

# Pub/Sub topic for meeting.completed events
gcloud pubsub topics create meeting-transcripts

# Push subscription (used by the deployed Cloud Run worker; local dev skips this)
gcloud pubsub subscriptions create meeting-transcripts-push \
  --topic=meeting-transcripts \
  --push-endpoint=https://transcript-worker.<region>.run.app/pubsub/push \
  --push-auth-service-account=transcript-worker-sa@vmtb-new.iam.gserviceaccount.com

# Pull subscription (used by the LOCAL dev loop — the forwarder script pulls
# from this and POSTs to your local worker, because push can't reach localhost)
gcloud pubsub subscriptions create meeting-transcripts-local \
  --topic=meeting-transcripts
```

Notes:
- The proxy publishes to the topic with its **default application credentials**
  (ADC): `gcloud auth application-default login` before running it locally.
- The local forwarder script pulls `meeting-transcripts-local` with ADC too, so
  no service-account JSON is needed on the dev machine.
- The push subscription / Cloud Run worker setup is only needed for the real
  deployment (see `docs/GCP_SETUP.md`); it is not required for local runs.

---

## 3. Service environment files

### 3.1 `opus-transcriber-proxy/.env`

```bash
cd opus-transcriber-proxy && cp .env.example .env
```

| Variable | Local value |
|---|---|
| `PROVIDER` | `self-hosted` |
| `STT_WS_URL` | `ws://localhost:9090/client/ws/speech` |
| `PERSISTENCE` | `supabase` |
| `SUPABASE_URL` | `https://togobilqdevoyijxrexc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your `service_role` key |
| `GCP_PROJECT_ID` | `vmtb-new` |
| `PUBSUB_TOPIC` | `meeting-transcripts` |
| `PUBSUB_EMULATOR_HOST` | *(leave empty)* |

### 3.2 `transcript-worker/.env`

```bash
cd transcript-worker && cp .env.example .env
```

| Variable | Local value |
|---|---|
| `SUPABASE_URL` | `https://togobilqdevoyijxrexc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | your `service_role` key |
| `GCS_BUCKET` | `vmtb-new-transcripts` |
| `GCP_PROJECT_ID` | `vmtb-new` |
| `PUBSUB_PUSH_TOKEN` | *(empty = disabled, fine for local)* |
| `LLM_PROVIDER` | `none` (skip MoM) — or `openai` with `LLM_API_KEY` to test MoM |

### 3.3 `stt-service` — no `.env` needed for defaults

The model defaults to `medium` (multilingual — required for Indian languages).
For a fast local CPU run, export before starting:

```bash
export STT_MODEL=base   # tiny/base are much faster on CPU; medium works too
export STT_DEVICE=cpu   # default; forced here for clarity
```

(`STT_DEVICE` auto-selects `cuda` if available.)

### 3.4 `main/` — already wired

`main/.env` already has the real `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
and `VITE_JITSI_BACKEND_URL`. Nothing to change for local runs.

---

## 4. Run the pipeline

Open four terminals and start each service. `npm install` first in
`opus-transcriber-proxy/` and `transcript-worker/` if not already done.

**Terminal 1 — STT service:**
```bash
cd stt-service
uv sync                       # first time only (creates .venv + uv.lock)
uv run python -m app.main     # listens on :9090
```

**Terminal 2 — transcription proxy:**
```bash
cd opus-transcriber-proxy
npm run dev                   # listens on :8080
```

**Terminal 3 — transcript worker:**
```bash
cd transcript-worker
npm run dev                   # listens on :8080
```

**Terminal 4 — Pub/Sub pull forwarder (bridges real Pub/Sub → local worker):**
```bash
cd transcript-worker
npm run local:pull
# pulls meeting-transcripts-local, POSTs each message to http://localhost:8080/pubsub/push
```

**Terminal 5 — simulate a JVB speaking the protocol:**
```bash
cd opus-transcriber-proxy
npm run simulate:jvb
# streams ~4s of real Opus audio (sine-wave fixture) and closes the session
```

---

## 5. Verify

After `simulate:jvb` finishes, in order:

1. **STT (`:9090`)** — proxy log shows `conn: started` and the STT round-trips.
2. **Proxy (`:8080`)** — log shows `session: closing` and `pubsub: publishing`.
3. **Pub/Sub** — the forwarder prints `POST http://localhost:8080/pubsub/push 200`.
4. **Worker (`:8080`)** — log shows the meeting claimed, GCS upload, and
   `complete_meeting_transcript` succeeded.
5. **Supabase** — SQL Editor:
   ```sql
   select * from meeting_transcripts order by created_at desc limit 5;
   select * from meeting_transcript_segments order by created_at desc limit 10;
   ```
   `meeting_transcripts.status` should be `COMPLETED` and the segments should
   contain the transcript rows.
6. **GCS**:
   ```bash
   gcloud storage ls gs://vmtb-new-transcripts/meetings/
   # → meetings/<sessionId>/transcript/transcript-v1.json + transcript-v1.txt
   ```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Proxy `pubsub: publishing disabled` | `GCP_PROJECT_ID`/`PUBSUB_TOPIC` not set, or no ADC — run `gcloud auth application-default login` |
| Forwarder `pull failed: ...` | Not authed (ADC) or subscription missing — run step 2 |
| Worker `401` on `/pubsub/push` | `PUBSUB_PUSH_TOKEN` mismatch — leave it empty locally |
| `meeting_transcripts.status = FAILED` | Worker logged the reason; check its terminal. Retry-safe: the meeting is claimed once |
| Empty/odd transcript | Expected — the fixture is a **440 Hz sine tone** (no speech); the sine repeats as "um"/"the". It exercises the whole pipeline, not ASR accuracy. A real voice fixture needs ffmpeg/`espeak` (not installed here) |
| STT slow on CPU | Use `STT_MODEL=base` (terminal 1) for local testing; `medium` is the production default |

## Important notes

- `meeting_id` everywhere is the JVB transcription **session id**, not
  `meeting_sessions.id` / `mtb_id`.
- Only **final** segments are persisted; interim segments exist only in memory.
- The legacy dictation pipeline (`VoiceRecorder`, `voiceTranscriptionService`)
  is untouched and unrelated.
- Do **not** run `simulate:jvb` with `PROVIDER=dummy` unless the STT service is
  off — it's a smoke test that skips real transcription.