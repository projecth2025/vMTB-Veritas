import { describe, expect, it } from 'vitest';
import { OutgoingConnection } from '../src/transcriberProxy.js';
import type { STTProvider, SttResult } from '../src/stt/types.js';

/**
 * The connection used to be tracked with three independent booleans
 * (started / draining / closed), which allowed combinations that should not
 * exist - e.g. draining=false while already closed. These cases pin the single
 * `state` field and its guarded transitions: buffering -> streaming ->
 * draining -> closed, with no jumps backwards.
 */

class TestSTT implements STTProvider {
  onResult?: (result: SttResult) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
  onEndOfStreamDone?: () => void;
  eosSent = false;
  closed = false;

  connect(): Promise<void> {
    this.onOpen?.();
    return Promise.resolve();
  }
  sendAudio(): void {}
  sendEndOfStream(): void {
    this.eosSent = true;
    this.onEndOfStreamDone?.();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function makeConn() {
  const stt = new TestSTT();
  const closedTags: string[] = [];
  const conn = new OutgoingConnection({
    tag: 'p1',
    sessionId: 'meeting-1',
    provider: 'test',
    sessionStartSec: 0,
    sampleRate: 16000,
    chunkMs: 60,
    drainTimeoutMs: 50,
    stt,
    onEvent: () => {},
    onError: () => {},
    onClosed: (tag) => closedTags.push(tag),
  });
  return { conn, stt, closedTags };
}

describe('OutgoingConnection state transitions', () => {
  it('starts buffering and moves to streaming on the first STT open', () => {
    const { conn, stt } = makeConn();
    expect(conn.connState).toBe('buffering');

    stt.onOpen?.();
    expect(conn.connState).toBe('streaming');
  });

  it('re-entrant open is a no-op: it never leaves streaming', () => {
    const { conn, stt } = makeConn();
    stt.onOpen?.();
    stt.onOpen?.();
    stt.onOpen?.();
    expect(conn.connState).toBe('streaming');
  });

  it('drainAndClose walks streaming -> draining -> closed', async () => {
    const { conn, stt, closedTags } = makeConn();
    stt.onOpen?.();

    await conn.drainAndClose();

    expect(conn.connState).toBe('closed');
    expect(stt.eosSent).toBe(true);
    expect(stt.closed).toBe(true);
    expect(closedTags).toEqual(['p1']);
  });

  it('draining is terminal: media arriving mid-drain is dropped, not buffered', async () => {
    const { conn, stt } = makeConn();
    stt.onOpen?.();

    // Hold the drain open so we can observe the draining state itself.
    stt.sendEndOfStream = () => {};
    const draining = conn.drainAndClose();
    expect(conn.connState).toBe('draining');

    conn.handleMedia({ payload: Buffer.from('late frame') });
    stt.onOpen?.(); // a late open must not un-drain it
    expect(conn.connState).toBe('draining');

    stt.onEndOfStreamDone?.();
    await draining;
    expect(conn.connState).toBe('closed');
  });

  it('closed is terminal: a late open cannot revive it', async () => {
    const { conn, stt, closedTags } = makeConn();
    stt.onOpen?.();
    await conn.drainAndClose();

    stt.onOpen?.();
    conn.handleMedia({ payload: Buffer.from('zombie frame') });

    expect(conn.connState).toBe('closed');
    expect(closedTags).toEqual(['p1']); // onClosed fired exactly once
  });

  it('sync close() goes straight to closed and is idempotent', () => {
    const { conn, stt, closedTags } = makeConn();
    stt.onOpen?.();

    conn.close();
    expect(conn.connState).toBe('closed');

    conn.close(); // second call must not re-run teardown
    expect(closedTags).toEqual(['p1']);
    expect(stt.closed).toBe(true);
  });

  it('close() from buffering skips streaming entirely', () => {
    const { conn, closedTags } = makeConn();
    expect(conn.connState).toBe('buffering');

    conn.close();

    expect(conn.connState).toBe('closed');
    expect(closedTags).toEqual(['p1']);
  });

  it('drainAndClose after close() is a no-op', async () => {
    const { conn, stt, closedTags } = makeConn();
    conn.close();

    await conn.drainAndClose();

    expect(conn.connState).toBe('closed');
    expect(stt.eosSent).toBe(false); // no end-of-stream handshake after a hard close
    expect(closedTags).toEqual(['p1']);
  });
});
