# stt-service

Streaming speech-to-text for the vMTB transcription pipeline. A single FastAPI
service that speaks the [WhisperLive](https://github.com/collabora/WhisperLive)
WebSocket protocol, transcribing with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(a CTranslate2-powered Whisper — no PyTorch, small image, fast CPU inference and
even faster on GPU).

```
opus-transcriber-proxy ──WS (PCM16 @ 16 kHz)──▶ stt-service (faster-whisper)
        ▲                                              │
        │                                    partial / final JSON results
        └──────────────────────────────────────┘
```

## Why faster-whisper and the default `medium` model

- Multilingual: Whisper `medium` supports ~99 languages and auto-detects the
  spoken language, which is what the MTB needs for Indian languages (Hindi,
  Tamil, Bengali, ...). `STT_LANGUAGE` can pin a language for accuracy.
- No PyTorch runtime: CTranslate2 keeps the container small and fast enough to
  run on a single CPU, and scales well on a Cloud Run GPU instance (L4).
- `small.en` was deliberately NOT chosen because it is English-only.

## Protocol

Client → server: **binary** frames of mono PCM16 little-endian @ 16 kHz.
Server → client (JSON):

| Message | Meaning |
|---|---|
| `{"message":"info","info":{...}}` | sent once on connect |
| `{"message":"partial","transcript":"..."}` | current (unstable) transcript of the tail |
| `{"message":"final","transcript":"..."}` | committed, non-overlapping segment |

When the client disconnects, whatever audio remains is flushed as one final
segment. This matches how the proxy persists only final segments.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | readiness — 200 only after the model is loaded |
| `GET /metrics` | model/device/session counters |
| `WS /client/ws/speech` | streaming endpoint |

## Streaming policy (committed prefix)

Each connection keeps a PCM buffer and re-transcribes it on a rolling basis
(`STT_CHUNK_SECONDS`, default 0.3s):

1. A `partial` is emitted for the tail that is not yet stable.
2. When the model's new full transcript diverges from the previous one, the
   stable prefix (never splitting a word, and requiring at least
   `STT_MIN_COMMIT_WORDS` words) is emitted as a `final`, and the corresponding
   audio is trimmed from the buffer to keep memory bounded.
3. On disconnect, the remainder is flushed as a final `final`.

This yields clean, non-overlapping final segments — exactly what the proxy
persists to Supabase.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `STT_HOST` | `0.0.0.0` | Bind address |
| `STT_PORT` | `9090` | Port |
| `STT_LOG_LEVEL` | `info` | uvicorn log level |
| `STT_MODEL` | `medium` | Whisper model name/size |
| `STT_LANGUAGE` | *(auto)* | Force a language, e.g. `hi`, `ta`, `bn` |
| `STT_BEAM_SIZE` | `1` | Beam size (1 = fastest streaming) |
| `STT_SAMPLE_RATE` | `16000` | Expected PCM sample rate |
| `STT_CHUNK_SECONDS` | `0.3` | Min audio between transcription runs |
| `STT_MIN_COMMIT_WORDS` | `2` | Min words before a prefix is committed |
| `STT_MAX_BUFFER_SECONDS` | `600` | Hard cap on the audio buffer |
| `STT_MAX_RUN_GAP_SECONDS` | `5` | Force a run if no audio chunk arrives in this window |
| `STT_DEVICE` | `auto` | `auto` \| `cpu` \| `cuda` |
| `STT_COMPUTE_TYPE` | `auto` | `auto` → `float16` on GPU, `int8` on CPU |

## Development

```bash
uv sync                              # creates an isolated .venv + uv.lock
uv run python -m pytest tests/ -q
uv run python -m app.main            # runs uvicorn (no model needed for tests)
```

Tests inject a fake transcriber, so no model download or GPU is required locally.
The streaming policy (`app/streaming.py`) is fully dependency-free and unit-tested.

## Container

CPU:

```bash
docker build -t stt-service .
docker run --rm -p 9090:9090 -e STT_MODEL=medium stt-service
```

GPU (Cloud Run GPU instance):

```bash
docker build --build-arg STT_DEVICE=gpu -t stt-service .
docker run --rm --gpus all -p 9090:9090 -e STT_MODEL=medium -e STT_DEVICE=cuda stt-service
```

The model is baked into the image at build time (the `RUN` step), so instances
start without network access to HuggingFace.

## Design notes

- **Serialised transcription**: CTranslate2 instances are not safe for concurrent
  use, so per-instance work is serialised (safe for one GPU). Raise the replica
  count / add per-connection engines when multi-stream concurrency is needed.
- **No audio persisted**: the service transcribes and discards; it never stores
  audio or transcript text.
- **Self-contained**: no secrets, no cloud SDK dependencies; it can run anywhere.