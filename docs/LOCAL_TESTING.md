# Local Testing Guide

How to test the whole vMTB Veritas application on your machine **before**
deploying to GCP (everything except `main/`, which goes to Vercel).

## Architecture — who talks to whom

```
Browser (main app)
  │  create case / schedule MTB / "Start Meeting"
  ▼
main (local :5173 / later Vercel)
  │  POST /start-jitsi            ── polling until "already_running"
  ▼
jitsi-activation-backend (Render, already live: https://jitsi-activation-backend.onrender.com)
  │  starts/stops Compute Engine VM "jitsi-vm" (asia-south1-c)
  ▼
Browser opens https://meet.vmtb.in/<room>  (jitsi-frontend, deployed)
  │  polls the same Render backend until the VM is up → embeds Jitsi
  ▼
JVB (inside the VM) ──WS (bridge transcription protocol)──▶ opus-transcriber-proxy
                                                              │ PCM16 @16kHz
                                                              ▼
                                                          stt-service (faster-whisper)
                                                              │ final segments
                                                              ▼
                                                          Supabase (meeting_transcripts + segments)
                                                              │ meeting.completed
                                                              ▼
                                                          Pub/Sub ──▶ transcript-worker ──▶ GCS + (LLM MoM)
```

**Key clarification:** the activation backend (Render) **never talks to the
proxy**. It only starts/stops the VM. The **only** thing that talks to the proxy
is the JVB running inside the GCP VM. So there is no "backend → proxy" link to
worry about.

## Why the JVB can't reach your laptop's proxy

The JVB runs inside a GCP VM. Your proxy listens on `localhost:8080`. The VM
cannot reach `localhost` on your machine. You have two ways to test
transcription:

| Option | What it is | When to use |
|---|---|---|
| **JVB simulator** | A script that speaks the JVB protocol locally (streams real Opus audio) | Default. Tests the whole pipeline with no Jitsi, no VM, no network |
| **Tunnel** | `cloudflared` exposes your local proxy at a public `wss://` URL that the VM's Jicofo connects to | Advanced. Real Jitsi meeting with live transcription |

## What you can test locally

| Thing to test | Fully local? | How |
|---|---|---|
| Transcription pipeline (proxy → STT → Supabase → Pub/Sub → worker → GCS) | ✅ | JVB simulator (Part 2) |
| STT accuracy (real faster-whisper, multilingual) | ✅ | Same; it's a real model on your machine |
| Meeting orchestration (create case → schedule MTB → start meeting → join) | ✅ UI local, backend/VM real | `main` locally + Render backend + real VM (Part 3) |
| Real Jitsi meeting **with** transcription | ⚠️ needs tunnel + VM config | Part 4 (advanced) |
| Transcription inside the deployed app | ❌ not yet | JVB config on the VM not applied yet |

---

## Part 0 — One-time setup

Already done / needed:

1. **Supabase migration applied** — run `main/supabase/migrations/20260820_meeting_transcripts.sql`
   in the Supabase SQL Editor (project `togobilqdevoyijxrexc`) if not already.
2. **Service role key** — Dashboard → Settings → API → `service_role`. Needed for
   the proxy and worker `.env` files.
3. **GCP** (project `vmtb-new`) — already created:
   - bucket `vmtb-new-transcripts`
   - Pub/Sub topic `meeting-transcripts`
   - pull subscription `meeting-transcripts-local` (used by the local forwarder)
4. **ADC for local Pub/Sub + GCS:**
   ```bash
   gcloud auth application-default login
   ```

### Env files

`opus-transcriber-proxy/.env`:
```
PROVIDER=self-hosted
STT_WS_URL=ws://localhost:9090/client/ws/speech
PERSISTENCE=supabase
SUPABASE_URL=https://togobilqdevoyijxrexc.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role>
GCP_PROJECT_ID=vmtb-new
PUBSUB_TOPIC=meeting-transcripts
```

`transcript-worker/.env`:
```
SUPABASE_URL=https://togobilqdevoyijxrexc.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role>
GCS_BUCKET=vmtb-new-transcripts
GCP_PROJECT_ID=vmtb-new
PUBSUB_PUSH_TOKEN=            # empty is fine locally
LLM_PROVIDER=none
```

`main/.env` already has the real Supabase + Render backend URLs. `stt-service`
needs no env file (optionally `STT_MODEL=base` for fast CPU testing).

---

## Part 2 — Test the transcription pipeline (no Jitsi needed)

Five terminals. `npm install` once in `opus-transcriber-proxy/` and
`transcript-worker/` if not done.

```bash
# T1 — STT
cd stt-service && uv sync && uv run python -m app.main        # :9090

# T2 — proxy
cd opus-transcriber-proxy && npm run dev                       # :8080

# T3 — worker
cd transcript-worker && npm run dev                            # :8080

# T4 — Pub/Sub pull forwarder (real Pub/Sub → local worker)
cd transcript-worker && npm run local:pull

# T5 — pretend to be the JVB: streams ~4s of real Opus audio, then closes
cd opus-transcriber-proxy && npm run simulate:jvb
```

**Verify:** after T5 finishes —
- `meeting_transcripts.status = 'COMPLETED'` (Supabase SQL Editor)
- rows in `meeting_transcript_segments`
- `gcloud storage ls gs://vmtb-new-transcripts/meetings/` shows `transcript-v1.json` + `transcript-v1.txt`

Full detail and troubleshooting: `docs/LOCAL_DEV.md`.

---

## Part 3 — Test the meeting orchestration (main app + real Jitsi VM)

This tests the real user flow. Everything runs against the live Render backend
and the real `jitsi-vm`, so **the VM will actually boot** (an e2 instance =
billed while running — stop it after).

1. Start the main app:
   ```bash
   cd main && npm install && npm run dev     # http://localhost:5173
   ```
2. Log in, create a case, schedule an MTB, then click **Start Meeting**.
3. Watch the flow:
   - `main` POSTs `/start-jitsi` to the Render backend and polls until
     `already_running` twice (90 s cap).
   - The Render backend boots `jitsi-vm` (takes ~1 min).
   - `main` opens `https://meet.vmtb.in/<room>`; the deployed jitsi-frontend
     polls the backend again and embeds the real Jitsi meeting.
4. Optionally run jitsi-frontend locally instead of using the deployed one:
   ```bash
   cd jitsi-frontend && cp .env.production .env.development && npm install && npm run dev
   # then change main/src/services/meeting.ts JITSI_MEET_URL to http://localhost:5174
   ```
5. **Stop the VM when done** to avoid compute cost:
   ```bash
   curl -X POST https://jitsi-activation-backend.onrender.com/stop-jitsi
   ```

**What this validates:** case → MTB → meeting orchestration, VM start/stop,
real Jitsi join.
**What it does NOT validate:** transcription — the JVB on the VM isn't wired to
a proxy yet (config not applied), so no audio is sent anywhere.

---

## Part 4 — Real Jitsi meeting WITH transcription (advanced)

Only do this once you want to hear the real JVB talking to your local proxy.

1. **Apply the JVB-side config** on the VM per `docs/JITSI_INTEGRATION.md`:
   - Prosody: enable transcription for rooms.
   - Jicofo: `jicofo.transcription.url-template = "wss://<TUNNEL>/transcribe?sessionId={{MEETING_ID}}&sendBack=true"`.
   - `config.js`: `transcription.enabled = true`.
2. **Expose your local proxy with a tunnel:**
   ```bash
   # install cloudflared once: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   cloudflared tunnel --url http://localhost:8080
   # prints something like: https://random-words.trycloudflare.com
   ```
3. Point the Jicofo url-template at `wss://random-words.trycloudflare.com/transcribe?...`,
   restart Jicofo/JVB, then start a real meeting and enable transcription in the
   meeting UI.

**Caveats:**
- The quick tunnel URL changes on every `cloudflared` restart — restart the VM
  Jicofo each time, or use a named tunnel.
- The VM must be running (`/start-jitsi`) for the meeting to exist at all.
- This is only worth doing after Part 2 works, so you know the pipeline itself
  is healthy.

---

## Part 5 — Does the STT service cost money when idle?

**Not while you test locally** — it runs on your machine (`uv run python -m app.main`)
and is not deployed anywhere. A container that isn't deployed costs nothing.

If/when you deploy it to Cloud Run, the answer depends on config:

| Deployment | Idle behavior | Cost |
|---|---|---|
| Cloud Run **GPU** (L4), `--min-instances=0` | **Scales to zero** when no transcription session is open (instance-based billing, per-second) | ~$0 when idle; pay only while transcribing. Cold start on the first call is ~1 min (CUDA init), so the *first* meeting after an idle stretch may miss its opening audio |
| Cloud Run **GPU**, `--min-instances=1` | Always warm | **~$1,000+/month** for L4 — not worth it for an MVP |
| Cloud Run **CPU-only**, `--min-instances=0` | Scales to zero | ~$0 idle; but `medium` is too slow for streaming on CPU — you'd use `base`/`small` and accept lower accuracy |
| Not deployed | — | Nothing |

Recommendation for MVP: **GPU with `--min-instances=0`** and accept the cold
start, or keep STT running somewhere cheap while testing. The proxy and worker
are CPU Cloud Run services with scale-to-zero — effectively $0 when idle. The
Jitsi VM is the only always-billable thing, and it's stopped between meetings by
the activation backend.

---

## Part 6 — Where everything deploys (later)

| Service | Target |
|---|---|
| `main/` | Vercel |
| `jitsi-frontend/` | Vercel (already live at meet.vmtb.in) |
| `jitsi-activation-backend/` | Render (already live) |
| `opus-transcriber-proxy/` | Cloud Run (CPU, scale-to-zero) |
| `stt-service/` | Cloud Run GPU (or CPU for cheap demo) |
| `transcript-worker/` | Cloud Run (CPU, Pub/Sub push) |
| GCS bucket + Pub/Sub | `vmtb-new` (created) |

Step-by-step deployment checklist: `docs/GCP_SETUP.md`.