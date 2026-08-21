import numpy as np
import pytest

from app.streaming import StreamingBuffer
from app.transcribe import Transcription, Transcriber

SR = 16000


class ScriptedTranscriber(Transcriber):
    """Returns the next scripted text per transcribe() call, recording audio lengths."""

    def __init__(self, texts: list[str], language: str | None = "en") -> None:
        super().__init__()
        self.texts = texts
        self.language = language
        self.calls: list[int] = []

    def transcribe(self, audio_pcm16: np.ndarray) -> Transcription:
        self.calls.append(audio_pcm16.size)
        text = self.texts[min(len(self.calls) - 1, len(self.texts) - 1)]
        return Transcription(text=text, is_final=False, language=self.language)


@pytest.fixture
def buffer() -> StreamingBuffer:
    return StreamingBuffer(sample_rate=SR, chunk_threshold_samples=4800, min_commit_words=2)


def silence(n_samples: int) -> np.ndarray:
    return np.zeros(n_samples, dtype=np.int16)


def test_enough_audio_to_run(buffer: StreamingBuffer):
    buffer.add(silence(2000))
    assert not buffer.enough_audio_to_run
    buffer.add(silence(4000))
    assert buffer.enough_audio_to_run


def test_partial_on_continuation(buffer: StreamingBuffer):
    # 1st run: brand-new text -> partial only
    t = ScriptedTranscriber(["hello world how are you", "hello world how are you today"])
    buffer.add(silence(SR))
    res = buffer.run(t)
    assert [r.text for r in res] == ["hello world how are you"]
    assert all(not r.is_final for r in res)

    # 2nd run: model extended the text -> partial for the tail only
    buffer.add(silence(SR))
    res = buffer.run(t)
    assert [r.text for r in res] == ["today"]
    assert not any(r.is_final for r in res)


def test_commit_stable_prefix(buffer: StreamingBuffer):
    t = ScriptedTranscriber(["hello world how are you today", "hello world how are you"])
    buffer.add(silence(SR))
    buffer.run(t)  # prev_text = "... today"

    buffer.add(silence(SR))
    res = buffer.run(t)  # new text revised back to "... you"
    finals = [r for r in res if r.is_final]
    partials = [r for r in res if not r.is_final]
    assert [r.text for r in finals] == ["hello world how are you"]
    assert partials == []
    assert buffer.committed_segments == 1


def test_audio_is_trimmed_after_commit(buffer: StreamingBuffer):
    # Second run revises the text so only the first part is stable -> that part
    # is committed and the corresponding audio is dropped.
    t = ScriptedTranscriber(["the quick brown fox jumps", "the quick brown dog runs", "whatever comes next"])
    buffer.add(silence(SR))
    buffer.run(t)  # prev = "the quick brown fox jumps"
    size_before = buffer.audio.size
    buffer.add(silence(SR))
    res = buffer.run(t)
    finals = [r for r in res if r.is_final]
    assert [r.text for r in finals] == ["the quick brown"]
    assert buffer.audio.size < size_before
    assert buffer.audio.size > 0
    assert buffer.committed_segments == 1


def test_no_commit_for_short_overlap(buffer: StreamingBuffer):
    t = ScriptedTranscriber(["totally different text", "different words entirely"])
    buffer.add(silence(SR))
    buffer.run(t)
    buffer.add(silence(SR))
    res = buffer.run(t)
    # LCP is only "differe" - fewer than 2 words -> no final committed
    assert not any(r.is_final for r in res)
    assert buffer.committed_segments == 0


def test_empty_transcript_resets_previous(buffer: StreamingBuffer):
    t = ScriptedTranscriber(["", "fresh start"])
    buffer.add(silence(SR))
    assert buffer.run(t) == []
    buffer.add(silence(SR))
    res = buffer.run(t)
    assert [r.text for r in res] == ["fresh start"]


def test_flush_final_commits_remaining(buffer: StreamingBuffer):
    t = ScriptedTranscriber(["uncommitted tail"])
    buffer.add(silence(SR))
    final = buffer.flush_final(t)
    assert final is not None
    assert final.text == "uncommitted tail"
    assert final.is_final is True
    assert buffer.committed_segments == 1


def test_flush_final_empty_buffer():
    b = StreamingBuffer(sample_rate=SR, chunk_threshold_samples=4800)
    assert b.flush_final(ScriptedTranscriber(["x"])) is None