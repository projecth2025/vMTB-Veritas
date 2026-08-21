"""Transcriber interface and the faster-whisper implementation.

faster-whisper is imported lazily so the rest of the app (and the test suite)
works without the heavy ML dependency installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Transcription:
    text: str
    is_final: bool
    language: str | None = None
    confidence: float | None = None


@dataclass
class Transcriber:
    """Base class; subclasses provide a transcribe() implementation.

    Implemented as a plain class with an injected callable so tests can supply a
    fake cheaply without subclassing gymnastics.
    """

    fn: object | None = field(default=None, repr=False)

    def transcribe(self, audio_pcm16: np.ndarray) -> Transcription:
        if self.fn is not None:
            return self.fn(audio_pcm16)  # type: ignore[no-any-return]
        raise NotImplementedError("transcribe() not implemented")


class WhisperTranscriber(Transcriber):
    """faster-whisper streaming worker for a single audio stream."""

    def __init__(self, model: str, language: str | None, device: str = "auto", compute_type: str = "auto", beam_size: int = 1) -> None:
        super().__init__()
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - depends on runtime env
            raise RuntimeError("faster-whisper is not installed") from exc

        if device == "auto":
            device = "cuda" if _cuda_available() else "cpu"
        if compute_type == "auto":
            compute_type = "float16" if device == "cuda" else "int8"

        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.language = language
        self.beam_size = beam_size
        self._device = device

    def transcribe(self, audio_pcm16: np.ndarray) -> Transcription:
        audio_float32 = audio_pcm16.astype(np.float32) / 32768.0
        segments, info = self.model.transcribe(
            audio_float32,
            language=self.language,
            beam_size=self.beam_size,
            condition_on_previous_text=True,
            vad_filter=False,
        )
        text = "".join(seg.text for seg in segments).strip()
        return Transcription(text=text, is_final=False, language=info.language)

    @property
    def device(self) -> str:
        return self._device


def _cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False