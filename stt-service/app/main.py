"""stt-service: streaming speech-to-text for the vMTB transcription pipeline.

A single FastAPI service exposing a WhisperLive-compatible WebSocket endpoint.
The opus-transcriber-proxy connects here and streams mono PCM16 @ 16 kHz; we
transcribe with faster-whisper and answer with:

    {"message": "partial", "transcript": "..."}
    {"message": "final",   "transcript": "..."}

Endpoints
---------
GET /health        liveness (always 200 once the process is up)
GET /ready         readiness (200 only after the model is loaded)
WS  /client/ws/speech   streaming endpoint
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from .config import settings
from .streaming import StreamingBuffer
from .transcribe import Transcriber, WhisperTranscriber

# Number of concurrent transcription runs we allow. CTranslate2 batches are not
# safe to share across threads; serialise per instance. Raise when GPU multisteam
# is added.
MAX_CONCURRENT = 1


def create_app(transcriber: Transcriber | None = None, *, stt_settings=None) -> FastAPI:
    cfg = stt_settings or settings
    engine: Transcriber | None = transcriber

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal engine
        if engine is None:
            # Load lazily at startup so tests (which inject a fake) never pull
            # in the ML stack. Model is downloaded on first load; in production
            # it is baked into the image at build time (see Dockerfile).
            engine = WhisperTranscriber(
                model=cfg.model,
                language=cfg.language,
                device=cfg.device,
                compute_type=cfg.compute_type,
                beam_size=cfg.beam_size,
            )
        app.state.engine = engine
        app.state.started = time.time()
        app.state.total_sessions = 0
        yield
        engine = None

    app = FastAPI(title="stt-service", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/ready")
    async def ready():
        engine_ = app.state.engine
        if engine_ is None:
            return {"status": "loading"}
        return {"status": "ok", "model": cfg.model, "device": getattr(engine_, "device", "unknown")}

    @app.get("/metrics")
    async def metrics():
        return {
            "model": cfg.model,
            "device": getattr(app.state.engine, "device", "unknown"),
            "language": cfg.language or "auto",
            "sessions": app.state.total_sessions,
        }

    @app.websocket("/client/ws/speech")
    async def speech(ws: WebSocket):
        await ws.accept()
        app.state.total_sessions += 1

        buffer = StreamingBuffer(
            sample_rate=cfg.sample_rate,
            chunk_threshold_samples=int(cfg.sample_rate * cfg.chunk_threshold_seconds),
            min_commit_words=cfg.min_commit_words,
        )

        await _send(ws, {"message": "info", "info": {"model": cfg.model, "language": cfg.language or "auto"}})

        last_run = time.monotonic()
        last_forced = last_run
        try:
            while True:
                message = await ws.receive()

                if message["type"] == "websocket.disconnect":
                    break

                if message["type"] == "websocket.receive" and "bytes" in message:
                    buffer.add(message["bytes"])

                now = time.monotonic()
                force = now - last_forced >= cfg.max_between_runs_seconds
                if buffer.enough_audio_to_run or force:
                    last_forced = now
                    if buffer.audio.size > 0:
                        results = await run_in_threadpool(buffer.run, app.state.engine)
                        for r in results:
                            await _send(ws, {"message": "final" if r.is_final else "partial", "transcript": r.text})
                    last_run = now

        except WebSocketDisconnect:
            pass

        # Final flush: commit whatever audio is left as one final segment.
        final = await run_in_threadpool(buffer.flush_final, app.state.engine)
        if final:
            await _send(ws, {"message": "final", "transcript": final.text})

    return app


async def _send(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        # Client gone mid-send; nothing sensible to do.
        pass


app = create_app()

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level)