import { describe, expect, it } from 'vitest';
import {
  buildPong,
  buildServerInfo,
  buildTranscriptionResult,
  isValidSessionId,
  parseInboundMessage,
  ProtocolError,
} from '../src/protocol.js';

describe('isValidSessionId', () => {
  it('accepts common session ids', () => {
    expect(isValidSessionId('abc123')).toBe(true);
    expect(isValidSessionId('room-name_2026.mtg')).toBe(true);
    expect(isValidSessionId('a/b.c-d_e')).toBe(true);
  });

  it('rejects too-long or unsafe ids', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('x'.repeat(129))).toBe(false);
    expect(isValidSessionId('has space')).toBe(false);
    expect(isValidSessionId('semi;colon')).toBe(false);
    expect(isValidSessionId('quote"quote')).toBe(false);
  });
});

describe('parseInboundMessage', () => {
  it('parses a ping', () => {
    const parsed = parseInboundMessage({ event: 'ping', id: 7 });
    expect(parsed).toEqual({ kind: 'ping', id: 7 });
  });

  it('parses a ping without an id', () => {
    const parsed = parseInboundMessage({ event: 'ping' });
    expect(parsed).toEqual({ kind: 'ping', id: undefined });
  });

  it('parses a start', () => {
    const parsed = parseInboundMessage({ event: 'start', start: { tag: 'participant-1' } });
    expect(parsed).toEqual({ kind: 'start', tag: 'participant-1' });
  });

  it('parses a media message and decodes base64 payload', () => {
    const payload = Buffer.from('hello', 'utf8');
    const parsed = parseInboundMessage({
      event: 'media',
      media: { tag: 'p1', chunk: 3, timestamp: 1234, payload: payload.toString('base64') },
    });
    expect(parsed.kind).toBe('media');
    expect(parsed.media?.tag).toBe('p1');
    expect(parsed.media?.chunk).toBe(3);
    expect(parsed.media?.timestamp).toBe(1234);
    expect(parsed.media?.payload.equals(payload)).toBe(true);
  });

  it('tolerates missing chunk/timestamp', () => {
    const parsed = parseInboundMessage({ event: 'media', media: { tag: 'p1', payload: 'AA==' } });
    expect(parsed.kind).toBe('media');
    expect(parsed.media?.chunk).toBe(0);
    expect(parsed.media?.timestamp).toBe(0);
  });

  it('parses info', () => {
    expect(parseInboundMessage({ event: 'info', anything: true }).kind).toBe('info');
  });

  it('returns unknown for unsupported events', () => {
    expect(parseInboundMessage({ event: 'something-else' }).kind).toBe('unknown');
  });

  it('rejects non-object messages', () => {
    expect(() => parseInboundMessage(null)).toThrow(ProtocolError);
    expect(() => parseInboundMessage('text')).toThrow(ProtocolError);
    expect(() => parseInboundMessage([1, 2])).toThrow(ProtocolError);
  });

  it('rejects malformed start/media', () => {
    expect(() => parseInboundMessage({ event: 'start' })).toThrow(ProtocolError);
    expect(() => parseInboundMessage({ event: 'start', start: {} })).toThrow(ProtocolError);
    expect(() => parseInboundMessage({ event: 'media' })).toThrow(ProtocolError);
    expect(() => parseInboundMessage({ event: 'media', media: { tag: 'p1' } })).toThrow(ProtocolError);
    expect(() => parseInboundMessage({ event: 'media', media: { tag: 'p1', payload: '###' } })).toThrow(ProtocolError);
  });

  it('rejects oversized payloads', () => {
    const big = Buffer.alloc(9000).toString('base64');
    expect(() => parseInboundMessage({ event: 'media', media: { tag: 'p1', payload: big } })).toThrow(ProtocolError);
  });
});

describe('buildTranscriptionResult', () => {
  it('builds a final transcription-result', () => {
    const result = buildTranscriptionResult({
      participantId: 'p1',
      text: 'hello',
      isFinal: true,
      timestamp: 123456789,
    });
    expect(result).toMatchObject({
      type: 'transcription-result',
      event: 'transcription-result',
      is_interim: false,
      transcript: [{ text: 'hello' }],
      participant: { id: 'p1' },
      timestamp: 123456789,
    });
  });

  it('marks interim results', () => {
    const result = buildTranscriptionResult({
      participantId: 'p1',
      text: 'hello',
      isFinal: false,
      timestamp: 1,
    });
    expect(result.is_interim).toBe(true);
  });

  it('includes language when provided', () => {
    const result = buildTranscriptionResult({
      participantId: 'p1',
      text: 'hi',
      isFinal: false,
      timestamp: 1,
      language: 'hi',
    });
    expect(result.language).toBe('hi');
  });
});

describe('builders', () => {
  it('builds a pong', () => {
    expect(buildPong(5)).toEqual({ event: 'pong', id: 5 });
    expect(buildPong()).toEqual({ event: 'pong' });
  });

  it('builds server info', () => {
    expect(buildServerInfo('s1', 'self-hosted')).toMatchObject({
      event: 'info',
      info: { application: 'vmtb-opus-transcriber-proxy', sessionId: 's1', provider: 'self-hosted' },
    });
  });
});