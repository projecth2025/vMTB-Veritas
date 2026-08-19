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

## Development

### Commands per service

| Service                    | Install        | Dev           | Build        | Typecheck / Lint           |
| -------------------------- | -------------- | ------------- | ------------ | -------------------------- |
| `main/`                    | `npm install`  | `npm run dev` | `npm run build` | `npm run typecheck`, `npm run lint` |
| `jitsi-frontend/`          | `npm install`  | `npm run dev` | `npm run build` | `npm run lint`             |
| `jitsi-activation-backend/`| `pip install -r requirements.txt` | `uvicorn main:app --reload` | — | — |

Each service keeps its own environment config and deployment files (Vercel for the frontends, Render for the backend) and is deployed independently.

### Environment variables
- `main/`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_JITSI_BACKEND_URL`.
- `jitsi-frontend/`: `VITE_JITSI_BACKEND_URL`, `VITE_JITSI_DOMAIN`, `VITE_MAIN_APP_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- `jitsi-activation-backend/`: `GCP_SERVICE_ACCOUNT_JSON`.

## Git Workflow

- The canonical (parent) repository is `projecth2025/vMTB-Veritas`; development forks add it as the `upstream` remote.
- Keep local `main` in sync with `upstream/main` before starting feature work (`git fetch upstream && git merge upstream/main`).
- Feature branches are created off `main` and merged via pull request.
- Commit messages follow a conventional style: `type: short summary` with a body describing the change.

## Current State

- The codebase was reorganized from three separate repositories into this monorepo (branch `feature/codebase-reorg`).
- The main application was relocated into `main/` as a pure move (100% similarity rename, no logic changes).
- All text files are normalized to LF line endings; nested `.git` directories from the cloned services were removed so their contents are tracked as regular files.