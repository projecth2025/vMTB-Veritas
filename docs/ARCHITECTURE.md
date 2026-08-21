# vMTB Meeting Transcription — Architecture

Bridge-based transcription for Jitsi meetings in the vMTB Veritas platform.
Audio stays inside GCP; nothing audio-related leaves the project.

```
                              ┌────────────────────────────────────────────┐
                              │                    GCP                      │
                              │                                            │
 Jitsi Video Bridge (JVB)     │                                            │
 (external, live on the VM)   │                                            │
 ───────────WS────────────────▶  opus-transcriber-proxy   (Cloud Run)      │
    JVB protocol:             │        │ decode Opus → PCM16 16k mono      │
    ping / start / media      │        │ per-participant STT connection    │
    (base64 Opus frames)      │        ▼                                   │
                              │  stt-service             (Cloud Run GPU)   │
                              │  faster-whisper (multilingual, medium)     │
                              │        │ partial / final segments          │
                              │        ▼                                   │
                              │  Supabase                                   │
                              │  meeting_transcript_segments (FINAL only)   │
                              │        │  meeting ends (WS close)           │
                              │        ▼                                   │
                              │  Pub/Sub  meeting.completed                 │
                              │        │  push                             │
                              │        ▼                                   │
                              │  transcript-worker       (Cloud Run)       │
                              │  claim → GCS artifacts → LLM MoM → COMPLETED│
                              └────────────────────────────────────────────┘
```

## Components

| Component | Language | Where it lives | Job |
|---|---|---|---|
| JVB (external) | — | not in this repo | Owns the meeting; speaks the bridge-based transcription protocol |
| `opus-transcriber-proxy` | TypeScript | `opus-transcriber-proxy/` | Accepts one WebSocket per meeting, decodes participant-tagged Opus → PCM16, streams to STT, persists final segments, publishes the completion event |
| `stt-service` | Python/FastAPI | `stt-service/` | WhisperLive-compatible streaming endpoint backed by faster-whisper (multilingual `medium`), committed-prefix streaming policy |
| Supabase | SQL | `main/supabase/migrations/20260820_meeting_transcripts.sql` | `meeting_transcripts` (status, GCS key, MoM) + `meeting_transcript_segments` (final segments) + RPCs |
| `transcript-worker` | TypeScript | `transcript-worker/` | Claims meetings idempotently, uploads artifacts to GCS, generates MoM via an OpenAI-compatible LLM, marks COMPLETED |
| Google Cloud | — | infra | Cloud Run (+GPU), Pub/Sub, GCS, Artifact Registry, Secret Manager |

## Identity model

`meeting_id` is the JVB transcription session id: the value Jicofo substitutes
into `jicofo.transcription.url-template` for `{{MEETING_ID}}`. It is an opaque
TEXT (the Jitsi conference meeting id) and is **not** `meeting_sessions.id` and
**not** `mtb_id`. `mtb_id` is NULL in the MVP. Reconcile later via Prosody room
metadata or a join on room name + start window.

## Data flow, in detail

1. **Start.** A user clicks *Start meeting* in `main/` → `jitsi-frontend`
   MeetingPage polls `POST /start-jitsi` (existing `jitsi-activation-backend`)
   and joins `meet.vmtb.in/<room>`. JVB begins transcription (see
   `docs/JITSI_INTEGRATION.md` for the JVB-side wiring) and opens
   `ws://<proxy>/transcribe?sessionId={{MEETING_ID}}&sendBack=true`.

2. **Real time.** JVB sends `start`/`media` events. The proxy creates one
   OutgoingConnection per participant tag (own Opus decoder + own STT
   connection), decodes to mono PCM16 @ 16 kHz, and forwards in 60 ms chunks.
   `stt-service` transcribes with a committed-prefix policy: it emits
   `partial` for the unstable tail and `final` for committed, non-overlapping
   segments. The proxy persists **only `final` segments** to Supabase and, when
   `sendBack=true`, echoes results to JVB for captions.

3. **Failure isolation.** STT / Supabase / Pub/Sub failures are logged and
   swallowed by the proxy — transcription degrades but never breaks the
   meeting. No raw audio is ever stored; audio exists only in memory.

4. **End of meeting.** JVB closes the WebSocket. The proxy ensures the
   `meeting_transcripts` row exists (PENDING), then publishes
   `meeting.completed {meeting_id, mtb_id:null}` to Pub/Sub.

5. **Post-processing.** `transcript-worker` (triggered by the Pub/Sub push
   subscription) atomically claims the meeting (`PENDING → PROCESSING`), reads
   the ordered segments, uploads `transcript-v1.json`/`.txt` to
   `gs://<bucket>/meetings/<meeting_id>/transcript/`, optionally generates MoM
   via LLM, then marks `COMPLETED` with the object key and MoM. Failures are
   recorded as `FAILED` and acked; only infra failures nack for redelivery.

## Status machine

```
                proxy (ensure)         worker (claim)        worker
   (none) ──▶ PENDING ────────────▶ PROCESSING ──────────▶ COMPLETED
                                        │                     
                                        └─(error)──▶ FAILED
```

- `ensure_meeting_transcript` — idempotent insert (proxy)
- `claim_meeting_transcript` — atomic PENDING→PROCESSING lock (worker)
- `complete_meeting_transcript` — PROCESSING→COMPLETED (worker)
- `fail_meeting_transcript` — PROCESSING→FAILED (worker)

All transitions are single-source-of-truth RPCs, so the proxy and worker can
never disagree about a meeting's state.

## Storage

- **Supabase** holds the live segment table (used by realtime/UI) and the
  meeting-level row with the GCS pointer + MoM.
- **GCS** holds the canonical, versioned artifacts:
  `meetings/<meeting_id>/transcript/transcript-v{version}.{json,txt}`.

## Trade-offs and notes

- **Only FINAL segments are stored** in Supabase — clean, non-duplicated
  utterance records; interim results live only in proxy memory.
- **Artifacts are generated post-meeting**, not during it, keeping the
  real-time path minimal.
- **MoM is best-effort** — LLM config is optional; meetings complete with a
  null MoM when no LLM is configured.
- **MVP scope**: `mtb_id` NULL, JVB not run inside this repo, no realtime UI
  wiring yet (the segments table is already in the `supabase_realtime`
  publication for a future live-transcript feature).