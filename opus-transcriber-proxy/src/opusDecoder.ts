import { OpusDecoder } from 'opus-decoder';
import logger from './logger.js';

// Decodes raw Opus RTP packets (as sent by JVB) to mono PCM16 at a target
// sample rate (default 16000 Hz). Uses the WASM libopus decoder from
// `opus-decoder` — no native compile step, works in plain Node and in Docker.
//
// Resampling 48000 -> 16000 is a simple linear-interpolation decimation. It is
// sufficient for the MVP; swap for a higher-quality resampler if STT accuracy
// regressions are observed.

export const SOURCE_SAMPLE_RATE = 48000;

/** Downmix any channel count to mono (Float32). */
export function mixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array(0);
  if (channelData.length === 1) return channelData[0]!;
  const len = channelData[0]!.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < channelData.length; c++) {
    const ch = channelData[c]!;
    for (let i = 0; i < len; i++) {
      mono[i]! += ch[i]!;
    }
  }
  const n = channelData.length;
  for (let i = 0; i < len; i++) {
    mono[i]! = mono[i]! / n;
  }
  return mono;
}

/** Linear-interpolation resample of a Float32 mono buffer. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** Convert Float32 PCM (-1..1) to PCM16 little-endian samples (Int16Array). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class OpusToPcm16 {
  private decoder: OpusDecoder;
  private _ready: Promise<void>;
  private decodedSamples = 0;
  private decodeErrors = 0;

  constructor() {
    this.decoder = new OpusDecoder();
    this._ready = this.decoder.ready;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  get stats(): { decodedSamples: number; decodeErrors: number } {
    return { decodedSamples: this.decodedSamples, decodeErrors: this.decodeErrors };
  }

  /**
   * Decode one raw Opus packet (the base64 `payload` from a JVB media event)
   * into mono PCM16 at the target sample rate.
   *
   * JVB generally sends one 20 ms Opus frame per media message. If a packet
   * contains several chained frames they would need to be split before
   * decodeFrame; a packet that fails to decode is logged and skipped so one bad
   * frame can never take down the session.
   *
   * @returns Int16Array of PCM16 mono samples at `targetSampleRate`.
   */
  async decode(payload: Buffer, targetSampleRate = 16000): Promise<Int16Array> {
    await this._ready;
    try {
      const { channelData, samplesDecoded, sampleRate } = this.decoder.decodeFrame(
        new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
      );
      if (samplesDecoded === 0) {
        return new Int16Array(0);
      }
      this.decodedSamples += samplesDecoded;

      const mono = mixToMono(channelData);
      const resampled = resample(mono, sampleRate, targetSampleRate);
      return floatToPcm16(resampled);
    } catch (err) {
      this.decodeErrors++;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), bytes: payload.length },
        'opus: packet decode failed, skipping frame',
      );
      return new Int16Array(0);
    }
  }

  async close(): Promise<void> {
    try {
      this.decoder.free();
    } catch {
      // already freed
    }
  }
}