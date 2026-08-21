# opus-transcriber-proxy

JVB → STT WebSocket transcription proxy for the Jitsi bridge-based transcription path.

Accepts the Jitsi bridge-based transcription protocol (one WebSocket per meeting), decodes participant-tagged Opus audio to mono PCM16, streams it to a self-hosted streaming STT backend, and persists final transcript segments to Supabase. On session close it emits a `meeting.completed` event to Google Cloud Pub/Sub so the downstream transcript worker can produce artifacts and minutes of meeting.

```
JVB (external) ──WS──▶ opus-transcriber-proxy ──PCM16 WS──▶ stt-service (faster-whisper)
                              │                                          │
                    final segments (Supabase)                  partial/final results
                              │
                    meeting.completed (Pub/Sub)
```

## Why this proxy exists

- The JVB speaks a binary, base64-encoded Opus RTP protocol that no stock STT API understands. The proxy translates it to plain PCM16.
- It decouples the meeting's real-time path from transcription: STT, Supabase or Pub/Sub failures are logged and swallowed, never thrown, so transcription can never break an active meeting.
- It is a self-contained, minimal implementation of the protocol in the upstream [jitsi/opus-transcriber-proxy](https://github.com/jitsi/opus-transcriber-proxy) reference, kept deliberately small so it can be deployed as a single container.

## Protocol (JVB side)

Client (JVB) → proxy:
- `{"event":"ping","id":N}` → proxy answers `{"event":"pong","id":N}`
- `{"event":"start","start":{"tag":"<participant-id>"}}` — opens an STT connection for that participant
- `{"event":"media","media":{"tag":"<participant-id>","chunk":N,"timestamp":N,"payload":"<base64 opus>"}}`
- `{"event":"info", ...}` — logged

Proxy → JVB (when `sendBack=true`):
- `{"type":"transcription-result","is_interim":bool,"transcript":[{"text":...}],"participant":{"id":...},"timestamp":...,"language":...}`

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe for Cloud Run / load balancer (always 200) |
| `GET /status` | `{"active_sessions": N}` — used to reason about scaling |
| `WS /transcribe?sessionId=<id>&provider=<self-hosted|dummy>` | JVB transcription endpoint |

## Configuration

All configuration is via environment variables (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8080` | Port |
| `LOG_LEVEL` | `info` | pino log level |
| `PROVIDER` | `self-hosted` | `self-hosted` or `dummy` (dev only) |
| `STT_WS_URL` | — | WebSocket URL of the self-hosted STT service (required for `self-hosted`) |
| `STT_SAMPLE_RATE` | `16000` | PCM sample rate sent to STT (Hz) |
| `STT_CHUNK_MS` | `60` | Ms of PCM accumulated before forwarding to STT |
| `PERSISTENCE` | `supabase` | `supabase` or `none` (local runs without a database) |
| `SUPABASE_URL` | — | Required when `PERSISTENCE=supabase` |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service-role key; kept server-side only, never in a browser |
| `GCP_PROJECT_ID` | — | GCP project for Pub/Sub publishing |
| `PUBSUB_TOPIC` | — | Pub/Sub topic for `meeting.completed` messages |
| `PUBSUB_EMULATOR_HOST` | — | Set for local Pub/Sub emulator use |
| `MAX_SESSION_ID_LENGTH` | `128` | Upper bound on session id length |

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev            # tsx watch
```

Local end-to-end without a GPU or a database:

```bash
PROVIDER=dummy \
PERSISTENCE=none \
STT_WS_URL=ws://stt:9090/client/ws/speech \
npm run dev
```

Point JVB (or a test client) at `ws://localhost:8080/transcribe?sessionId=test-room`. With `PROVIDER=dummy` the proxy emits synthetic final segments so the whole pipeline is exercisable offline.

## Tests

- `tests/protocol.test.ts` — JVB message parsing/validation
- `tests/opusDecoder.test.ts` — DSP helpers + real Opus frame decode (fixture generated with ffmpeg)
- `tests/transcriberProxy.test.ts` — session orchestration with a fake WebSocket + controllable STT
- `tests/stt.selfHosted.test.ts` — STT client against a fake WhisperLive-compatible server
- `tests/store.supabase.test.ts` — persistence layer with a mocked Supabase client

## Container

```bash
docker build -t opus-transcriber-proxy .
docker run --rm -p 8080:8080 \
  -e PROVIDER=self-hosted \
  -e STT_WS_URL=ws://stt-service:9090/client/ws/speech \
  -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... \
  opus-transcriber-proxy
```

## Design notes

- **Only final segments are persisted.** Interim results stay in connection memory and are never written to Supabase, so the store contains clean, non-duplicated utterance records.
- **Failure isolation.** Every external dependency (STT, Supabase, Pub/Sub) is isolated behind the transcript event flow; a backend outage degrades transcription but never the meeting.
- **No raw audio stored, no secrets logged.** Audio is decoded in-memory and discarded. pino redaction strips payloads/transcripts from logs.
- **No artifacts.** This service only produces segments + the completion event. Artifact generation (JSON/TXT + minutes of meeting) is owned by the transcript-worker service.