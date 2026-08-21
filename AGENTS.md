# AGENTS.md

## Project Overview

**vMTB Veritas** is a virtual Molecular Tumor Board (MTB) platform that lets multidisciplinary oncology teams collaborate on complex cancer cases, review genomic profiles, and run structured case discussions. The platform consists of three services that previously lived in three separate repositories and have been consolidated into a single monorepo.

## Repository Structure (Monorepo)

```text
vMTB-Veritas/
├── main/                        # Primary clinical web application
│   ├── src/                     # React + TypeScript + Vite source
│   │   ├── components/          # Reusable UI (Layout, Modal, PasswordStrength, etc.)
│   │   ├── context/             # AuthContext, CasesContext, CaseCreationContext
│   │   ├── hooks/               # Custom hooks (useMobile, etc.)
│   │   ├── pages/               # Login, Signup, MyCases, MTBs, case workflow views
│   │   ├── services/            # meeting.ts, whatsappOtp.ts, voiceTranscriptionService.ts
│   │   ├── Supabase/            # Supabase client configuration
│   │   └── utils/               # Shared helpers
│   ├── supabase/                # Edge Functions, migrations, SQL schemas
│   └── package.json
├── jitsi-activation-backend/    # FastAPI service that controls the Jitsi VM
│   └── main.py                  # /start-jitsi and /stop-jitsi endpoints (GCP Compute)
├── jitsi-frontend/              # Jitsi meeting controller app
│   └── src/
│       ├── pages/               # MeetingPage and meeting flow components
│       ├── services/            # meetingService.ts (polling), meetingAnalytics.ts (Supabase)
│       └── utils/               # sanitization.ts helpers
├── opus-transcriber-proxy/      # JVB -> STT WebSocket transcription proxy (Cloud Run)
│   ├── src/                     # TS: server.ts, transcriberProxy.ts, opusDecoder.ts, protocol.ts
│   │   ├── stt/                 # selfHosted.ts (WhisperLive client), dummy.ts, factory.ts
│   │   └── store/               # supabase.ts (segments), pubsub.ts (meeting.completed)
│   └── tests/
├── stt-service/                 # Streaming STT (faster-whisper, multilingual medium) (Cloud Run GPU)
│   └── app/                     # main.py (FastAPI + WhisperLive WS), streaming.py, transcribe.py
├── transcript-worker/           # Post-meeting worker (Cloud Run, Pub/Sub push)
│   └── src/                     # TS: server.ts, worker.ts, supabase.ts, gcs.ts, llm.ts
├── docs/                        # ARCHITECTURE.md, GCP_SETUP.md, JITSI_INTEGRATION.md
└── .opencode/commands/          # Custom opencode slash commands
```

## Service Overview

### `main/` — Primary Application
React 18 + TypeScript + Vite frontend backed by Supabase (Auth, PostgreSQL, Storage, Edge Functions).
- Multi-factor auth: Google OAuth, phone + password, WhatsApp OTP (via Gupshup + Supabase Edge Function `verify_whatsapp_otp`).
- Multi-step case creation workflow with PDF/image uploads and HEIC conversion (`heic2any`).
- MTB dashboards, discussion boards with markdown rendering, and meeting orchestration via `src/services/meeting.ts`.
- Routes are protected via `ProtectedRoute` guards in `src/App.tsx`.

### `jitsi-activation-backend/` — Jitsi VM Control
Python FastAPI service. Reads GCP service-account credentials from the `GCP_SERVICE_ACCOUNT_JSON` env var and controls a Compute Engine instance (`jitsi-vm` in `asia-south1-c`).
- `POST /start-jitsi` — starts the VM; returns `already_running` or `starting`.
- `POST /stop-jitsi` — stops the VM; returns `already_stopped` or `stopping`.
- `GET /` and `HEAD /` — health check for uptime monitors (UptimeRobot/Render).

### `jitsi-frontend/` — Meeting Controller
React + Vite app that manages the Jitsi meeting lifecycle at `meet.vmtb.in`.
- `meetingService.ts` — polls the activation backend until the Jitsi server is ready (5-min cap, consecutive-error tolerance).
- `meetingAnalytics.ts` — writes meeting sessions and participant records to Supabase with heartbeat tracking and stale-session handling.
- `sanitization.ts` — room-name and URL sanitization helpers.

### `opus-transcriber-proxy/` — JVB → STT Transcription Proxy (Cloud Run)
TypeScript. Accepts the Jitsi bridge-based transcription protocol (one WebSocket per meeting at `/transcribe?sessionId=<id>`), decodes participant-tagged Opus frames (`opus-decoder` WASM) to mono PCM16 @ 16 kHz, streams to the STT backend, persists **final** segments to Supabase, and publishes a `meeting.completed` Pub/Sub event when the session closes.
- `src/protocol.ts` — JVB wire protocol parsing + `transcription-result` building.
- `src/opusDecoder.ts` — Opus → PCM16 (mix-to-mono + linear resample to 16 kHz).
- `src/transcriberProxy.ts` — per-session orchestration; one OutgoingConnection per participant tag (own decoder + STT).
- `src/stt/selfHosted.ts` — WhisperLive-compatible WS client; `src/stt/dummy.ts` — offline test provider.
- `src/store/supabase.ts` — final segment persistence; `src/store/pubsub.ts` — `meeting.completed` publishing.
- Failure isolation: STT/Supabase/Pub/Sub errors are logged and swallowed — transcription never breaks a meeting.
- See `src/config.ts` / `.env.example` for env vars.

### `stt-service/` — Streaming STT (Cloud Run GPU)
Python FastAPI. Exposes a WhisperLive-compatible WS endpoint at `/client/ws/speech` (binary PCM16 in, `partial`/`final` JSON out) powered by faster-whisper. Default model is **`medium`** (multilingual, auto language detection — required for Indian languages; `small.en` is NOT acceptable). Streaming policy in `app/streaming.py` is a committed-prefix algorithm (emits `final` for stable prefixes, never splitting words) and is dependency-free for unit testing. `app/transcribe.py` lazy-imports faster-whisper so tests run without the ML stack. Env vars are prefixed `STT_`.

### `transcript-worker/` — Post-meeting Worker (Cloud Run, Pub/Sub push)
TypeScript. `POST /pubsub/push` (Bearer-token protected) receives `meeting.completed`, then atomically claims the meeting (`claim_meeting_transcript`, idempotent `PENDING → PROCESSING` lock), reads ordered segments from Supabase, uploads `transcript-v{version}.{json,txt}` to GCS, optionally generates Minutes-of-Meeting via an OpenAI-compatible endpoint (`src/llm.ts`), and marks `COMPLETED` (`complete_meeting_transcript`). Meeting-level failures mark `FAILED` and are acked; only infra failures nack for redelivery.

## Development

For a full local run of the transcription pipeline without Docker (real GCS,
real Pub/Sub, real Supabase), see `docs/LOCAL_DEV.md`. For a broader guide that
also covers testing the meeting orchestration with the real Jitsi VM (and the
"JVB can't reach your laptop" problem), see `docs/LOCAL_TESTING.md`.

### Commands per service

| Service                    | Install        | Dev           | Build        | Typecheck / Lint           |
| -------------------------- | -------------- | ------------- | ------------ | -------------------------- |
| `main/`                    | `npm install`  | `npm run dev` | `npm run build` | `npm run typecheck`, `npm run lint` |
| `jitsi-frontend/`          | `npm install`  | `npm run dev` | `npm run build` | `npm run lint`             |
| `jitsi-activation-backend/`| `pip install -r requirements.txt` | `uvicorn main:app --reload` | — | — |
| `opus-transcriber-proxy/`  | `npm install`  | `npm run dev` | `npm run build` | `npm run typecheck`, `npm test` |
| `stt-service/`             | `uv sync` (isolated `.venv`) | `uv run python -m app.main` | — | `uv run python -m pytest tests/ -q` |
| `transcript-worker/`       | `npm install`  | `npm run dev` | `npm run build` | `npm run typecheck`, `npm test` |

Each service keeps its own environment config and deployment files (Vercel for the frontends, Render for the backend, Cloud Run for the transcription services) and is deployed independently.

### Environment variables
- `main/`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_JITSI_BACKEND_URL`.
- `jitsi-frontend/`: `VITE_JITSI_BACKEND_URL`, `VITE_JITSI_DOMAIN`, `VITE_MAIN_APP_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- `jitsi-activation-backend/`: `GCP_SERVICE_ACCOUNT_JSON`.
- `opus-transcriber-proxy/`: `HOST`, `PORT`, `LOG_LEVEL`, `PROVIDER` (`self-hosted`\|`dummy`), `STT_WS_URL`, `STT_SAMPLE_RATE`, `STT_CHUNK_MS`, `PERSISTENCE` (`supabase`\|`none`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GCP_PROJECT_ID`, `PUBSUB_TOPIC`, `PUBSUB_EMULATOR_HOST`, `MAX_SESSION_ID_LENGTH`.
- `stt-service/`: `STT_*` (model, language, sample rate, chunk/commit thresholds, device, compute type).
- `transcript-worker/`: `HOST`, `PORT`, `LOG_LEVEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GCS_BUCKET`, `GCP_PROJECT_ID`, `PUBSUB_PUSH_TOKEN`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

### Meeting transcription architecture
- See `docs/ARCHITECTURE.md` for the end-to-end data flow, `docs/GCP_SETUP.md` for a beginner-level deployment checklist, and `docs/JITSI_INTEGRATION.md` for the Prosody/Jicofo/config.js changes needed on the Jitsi VM.
- `meeting_id` in `meeting_transcripts`/`meeting_transcript_segments` is the JVB transcription session id (`{{MEETING_ID}}`), NOT `meeting_sessions.id` or `mtb_id`. `mtb_id` is NULL in the MVP.
- Supabase schema for this pipeline lives in `main/supabase/migrations/20260820_meeting_transcripts.sql` (tables, RPCs, RLS, realtime).
- Do NOT touch the legacy dictation pipeline (`main/src/services/voiceTranscriptionService.ts`, `main/src/components/VoiceRecorder.tsx`) — it stays.

## Git Workflow

- The canonical (parent) repository is `projecth2025/vMTB-Veritas`; development forks add it as the `upstream` remote.
- Keep local `main` in sync with `upstream/main` before starting feature work (`git fetch upstream && git merge upstream/main`).
- Feature branches are created off `main` and merged via pull request.
- Commit messages follow a conventional style: `type: short summary` with a body describing the change.

## Current State

- The codebase was reorganized from three separate repositories into this monorepo (branch `feature/codebase-reorg`).
- The main application was relocated into `main/` as a pure move (100% similarity rename, no logic changes).
- All text files are normalized to LF line endings; nested `.git` directories from the cloned services were removed so their contents are tracked as regular files.
- Bridge-based meeting transcription (MVP) was added: `opus-transcriber-proxy/`, `stt-service/` and `transcript-worker/` are implemented and tested; the Supabase schema lives in `main/supabase/migrations/20260820_meeting_transcripts.sql`. Deployment wiring (Cloud Run/Pub/Sub/GCS) and JVB-side config are documented in `docs/` but not yet applied.