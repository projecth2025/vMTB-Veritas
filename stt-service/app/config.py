"""Environment-driven configuration for the stt-service.

All knobs are environment variables so the same image works for GPU and CPU
Cloud Run instances. Secrets/keys are never configured here.
"""

import os


class Settings:
    def __init__(self) -> None:
        self.host = os.environ.get("STT_HOST", "0.0.0.0")
        self.port = int(os.environ.get("STT_PORT", "9090"))
        self.log_level = os.environ.get("STT_LOG_LEVEL", "info")

        # Whisper model
        self.model = os.environ.get("STT_MODEL", "medium")
        # Language auto-detect by default; set e.g. STT_LANGUAGE=hi to force Hindi.
        self.language = os.environ.get("STT_LANGUAGE", "") or None
        self.beam_size = int(os.environ.get("STT_BEAM_SIZE", "1"))

        # Streaming policy
        self.sample_rate = int(os.environ.get("STT_SAMPLE_RATE", "16000"))
        self.chunk_threshold_seconds = float(os.environ.get("STT_CHUNK_SECONDS", "0.3"))
        self.min_commit_words = int(os.environ.get("STT_MIN_COMMIT_WORDS", "2"))
        # Hard cap on the in-memory audio buffer (seconds). Prevents unbounded
        # growth on long meetings when partials never stabilise.
        self.max_buffer_seconds = float(os.environ.get("STT_MAX_BUFFER_SECONDS", "600"))
        # Maximum wall-clock time between transcription runs (seconds).
        self.max_between_runs_seconds = float(os.environ.get("STT_MAX_RUN_GAP_SECONDS", "5.0"))

        # Compute
        self.device = os.environ.get("STT_DEVICE", "auto")  # auto | cpu | cuda
        self.compute_type = os.environ.get("STT_COMPUTE_TYPE", "auto")  # auto | float16 | int8 | float32


settings = Settings()