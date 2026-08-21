"""Pure streaming-transcription policy (no model dependency).

Implements the committed-prefix approach used by WhisperLive:

  - audio accumulates in a buffer
  - each transcription run transcribes the whole buffer
  - a "partial" is emitted for the not-yet-committed tail
  - when a stable prefix is detected between the previous and current full
    transcripts, that prefix is emitted as a "final" segment and the
    corresponding audio is trimmed from the buffer

Keeping the policy dependency-free lets it be unit-tested without a model or
network access.
"""

from __future__ import annotations

import numpy as np

from .transcribe import Transcriber, Transcription


def _longest_common_prefix(a: str, b: str) -> str:
    """Longest common prefix of two strings (ends on a word boundary)."""
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i].lower() == b[i].lower():
        i += 1
    # If we stopped at a clean word boundary (end of one string, or a space),
    # `i` is already safe. Only when the mismatch is mid-word do we back off to
    # the previous space so we never split a word.
    if i < limit and a[i] != " ":
        while i > 0 and a[i - 1] != " ":
            i -= 1
    return a[:i].strip()


class StreamingBuffer:
    def __init__(self, sample_rate: int, chunk_threshold_samples: int, min_commit_words: int = 2) -> None:
        self.sample_rate = sample_rate
        self.chunk_threshold_samples = chunk_threshold_samples
        self.min_commit_words = min_commit_words

        self.audio: np.ndarray = np.zeros(0, dtype=np.int16)
        self.previous_text = ""
        self._samples_since_last_run = 0
        self.committed_segments = 0

    def add(self, pcm: bytes | np.ndarray) -> None:
        """Append PCM16 mono samples (bytes or int16 array)."""
        if isinstance(pcm, bytes):
            samples = np.frombuffer(pcm, dtype=np.int16)
        else:
            samples = pcm
        if samples.size == 0:
            return
        self.audio = np.concatenate([self.audio, samples])
        self._samples_since_last_run += samples.size

    @property
    def enough_audio_to_run(self) -> bool:
        return self._samples_since_last_run >= self.chunk_threshold_samples

    def run(self, transcriber: Transcriber) -> list[Transcription]:
        """Transcribe the buffer and produce partial/final results.

        Returns at most two items: a possible final for the committed prefix and
        a partial for the remaining tail. Callers forward them over the wire.
        """
        self._samples_since_last_run = 0
        if self.audio.size == 0:
            return []

        full = transcriber.transcribe(self.audio)
        if not full.text:
            # Reset previous text on silence so trailing noise doesn't poison
            # the next utterance's prefix matching.
            self.previous_text = ""
            return []

        results: list[Transcription] = []

        if self.previous_text and full.text.lower().startswith(self.previous_text.lower()):
            # Model continued cleanly; nothing new is stable yet.
            tail = full.text[len(self.previous_text) :].strip()
        else:
            # Model changed its mind about earlier text: the stable prefix of the
            # previous transcript is the committed part (if long enough).
            lcp = _longest_common_prefix(self.previous_text, full.text)
            word_count = len(lcp.split())
            if lcp and word_count >= self.min_commit_words:
                self.committed_segments += 1
                results.append(Transcription(text=lcp.strip(), is_final=True))
                self._trim_audio_for_text(lcp, full.text)
                tail = full.text[len(lcp) :].strip()
            else:
                tail = full.text

        self.previous_text = full.text

        if tail:
            results.append(Transcription(text=tail, is_final=False))
        return results

    def _trim_audio_for_text(self, committed: str, full_text: str) -> None:
        """Drop the audio estimated to correspond to the committed text.

        Uses average samples-per-character as the estimate; slight drift is
        acceptable for the MVP.
        """
        if len(full_text) <= 0:
            return
        avg_samples_per_char = len(self.audio) / len(full_text)
        trim_samples = int(len(committed) * avg_samples_per_char)
        if trim_samples > 0:
            self.audio = self.audio[trim_samples:]

    def flush_final(self, transcriber: Transcriber) -> Transcription | None:
        """Final run at stream end: commit everything remaining as one final."""
        if self.audio.size == 0:
            return None
        full = transcriber.transcribe(self.audio)
        if not full.text:
            return None
        self.committed_segments += 1
        return Transcription(text=full.text.strip(), is_final=True, language=full.language)