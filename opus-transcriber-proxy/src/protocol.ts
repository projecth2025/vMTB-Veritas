// JVB <-> transcription proxy wire protocol.
//
// This is the protocol used by the Jitsi bridge-based transcription path
// (see https://jitsi.github.io/handbook/docs/devops-guide/transcription/ and the
// upstream reference implementation jitsi/opus-transcriber-proxy).
//
// Client (JVB) -> proxy:
//   { "event": "ping",  "id": 123 }
//   { "event": "start", "start": { "tag": "participant-7", "mediaFormat": {...} } }
//   { "event": "media", "media": { "tag": "participant-7", "chunk": 42,
//                                  "timestamp": 1751979219, "payload": "<base64 opus>" } }
//   { "event": "info",  ... }
//
// Proxy -> client (JVB):
//   { "event": "pong", "id": 123 }
//   { "type": "transcription-result", "participant": { "id": "participant-7" },
//     "language": "en", "is_interim": false,
//     "transcript": [ { "text": "hello world", "confidence": 0.98 } ],
//     "timestamp": 1751979219000 }

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_\-./]{1,128}$/;

export const MAX_PARTICIPANT_TAG_LENGTH = 128;
export const MAX_MEDIA_PAYLOAD_BYTES = 8192; // hard guard against oversized frames

export interface PingMessage {
  event: 'ping';
  id?: number;
}

export interface StartMessage {
  event: 'start';
  start?: {
    tag?: string;
    mediaFormat?: unknown;
  };
}

export interface MediaMessage {
  event: 'media';
  media?: {
    tag?: string;
    chunk?: number;
    timestamp?: number;
    payload?: string;
  };
}

export interface InfoMessage {
  event: 'info';
  [key: string]: unknown;
}

export type InboundMessage = PingMessage | StartMessage | MediaMessage | InfoMessage;

export interface TranscriptionResult {
  type: 'transcription-result';
  event: 'transcription-result';
  is_interim: boolean;
  transcript: Array<{ text: string; confidence?: number }>;
  participant: { id: string };
  timestamp: number;
  language?: string;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function buildPong(id?: number): object {
  return id === undefined ? { event: 'pong' } : { event: 'pong', id };
}

export function buildServerInfo(sessionId: string, provider: string): object {
  return {
    event: 'info',
    info: {
      application: 'vmtb-opus-transcriber-proxy',
      sessionId,
      provider,
    },
  };
}

export function buildTranscriptionResult(input: {
  participantId: string;
  text: string;
  isFinal: boolean;
  timestamp: number;
  confidence?: number;
  language?: string;
}): TranscriptionResult {
  return {
    type: 'transcription-result',
    event: 'transcription-result',
    is_interim: !input.isFinal,
    transcript: [{ text: input.text, ...(input.confidence !== undefined ? { confidence: input.confidence } : {}) }],
    participant: { id: input.participantId },
    timestamp: input.timestamp,
    ...(input.language ? { language: input.language } : {}),
  };
}

export interface ParsedInbound {
  kind: 'ping' | 'start' | 'media' | 'info' | 'unknown';
  id?: number;
  tag?: string;
  media?: {
    tag: string;
    chunk: number;
    timestamp: number;
    payload: Buffer;
  };
}

/**
 * Validate and normalize a single inbound JSON message from JVB.
 * Throws a ProtocolError describing the problem for invalid messages.
 */
export function parseInboundMessage(raw: unknown): ParsedInbound {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProtocolError('Message must be a JSON object');
  }

  const msg = raw as Record<string, unknown>;
  const event = msg['event'];

  if (event === 'ping') {
    const id = msg['id'];
    if (id !== undefined && typeof id !== 'number') {
      throw new ProtocolError('ping.id must be a number');
    }
    return { kind: 'ping', id: id as number | undefined };
  }

  if (event === 'start') {
    const start = msg['start'] as Record<string, unknown> | undefined;
    const tag = start?.['tag'];
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new ProtocolError('start.start.tag must be a non-empty string');
    }
    if (tag.length > MAX_PARTICIPANT_TAG_LENGTH) {
      throw new ProtocolError('start.start.tag is too long');
    }
    return { kind: 'start', tag };
  }

  if (event === 'media') {
    const media = msg['media'] as Record<string, unknown> | undefined;
    if (!media || typeof media !== 'object') {
      throw new ProtocolError('media.media must be an object');
    }
    const tag = media['tag'];
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new ProtocolError('media.media.tag must be a non-empty string');
    }
    if (tag.length > MAX_PARTICIPANT_TAG_LENGTH) {
      throw new ProtocolError('media.media.tag is too long');
    }
    const payload = media['payload'];
    if (typeof payload !== 'string' || payload.length === 0) {
      throw new ProtocolError('media.media.payload must be a non-empty base64 string');
    }
    let payloadBytes: Buffer;
    try {
      payloadBytes = Buffer.from(payload, 'base64');
    } catch {
      throw new ProtocolError('media.media.payload is not valid base64');
    }
    if (payloadBytes.length === 0) {
      throw new ProtocolError('media.media.payload decodes to an empty buffer');
    }
    if (payloadBytes.length > MAX_MEDIA_PAYLOAD_BYTES) {
      throw new ProtocolError('media.media.payload exceeds the maximum frame size');
    }
    const chunk = media['chunk'];
    const timestamp = media['timestamp'];
    return {
      kind: 'media',
      media: {
        tag,
        chunk: typeof chunk === 'number' ? chunk : 0,
        timestamp: typeof timestamp === 'number' ? timestamp : 0,
        payload: payloadBytes,
      },
    };
  }

  if (event === 'info') {
    return { kind: 'info' };
  }

  return { kind: 'unknown' };
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}