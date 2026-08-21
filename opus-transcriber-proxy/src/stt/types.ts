// STT backend abstraction. The proxy's JVB-facing layer only talks to this
// interface, so new backends (OpenAI, Deepgram, OpenAI-compatible endpoints)
// can be added without touching the JVB WebSocket layer.

export interface SttResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
}

export interface STTProvider {
  /** Open the backend connection. Must resolve before sendAudio is called. */
  connect(): Promise<void>;
  /** Feed a chunk of mono PCM16 audio at the configured sample rate. */
  sendAudio(pcm16: Uint8Array): void;
  /** Emitted for interim and final transcription results. */
  onResult?: (result: SttResult) => void;
  /** Emitted on unrecoverable backend errors. */
  onError?: (err: Error) => void;
  /** Close the backend connection. */
  close(): Promise<void>;
}

/**
 * Internal normalized transcript event (the format used by the persistence
 * layer). `startTime`/`endTime` are seconds relative to the proxy session
 * start. Participant identity is preserved from the JVB media `tag`.
 */
export interface TranscriptEvent {
  meetingId: string;
  participantId: string;
  startTime: number;
  endTime: number;
  text: string;
  isFinal: boolean;
  provider: string;
}