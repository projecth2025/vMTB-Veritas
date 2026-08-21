import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  floatToPcm16,
  mixToMono,
  OpusToPcm16,
  resample,
  SOURCE_SAMPLE_RATE,
} from '../src/opusDecoder.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function loadFixture(): Promise<Buffer[]> {
  const text = await readFile(join(fixturesDir, 'sine_opus_frames.b64'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => Buffer.from(line, 'base64'));
}

describe('pure DSP helpers', () => {
  it('mixToMono averages channels', () => {
    const left = new Float32Array([1, -1]);
    const right = new Float32Array([3, 1]);
    const mono = mixToMono([left, right]);
    expect(Array.from(mono)).toEqual([2, 0]);
  });

  it('mixToMono passes single channel through', () => {
    const ch = new Float32Array([0.5]);
    expect(mixToMono([ch])).toBe(ch);
  });

  it('mixToMono handles empty input', () => {
    expect(mixToMono([]).length).toBe(0);
  });

  it('resample decimates 48k -> 16k to exactly 1/3 the length', () => {
    const input = new Float32Array(900);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i);
    const out = resample(input, SOURCE_SAMPLE_RATE, 16000);
    expect(out.length).toBe(300);
    // endpoints should match the source (ratio is integer)
    expect(out[0]).toBeCloseTo(input[0] as number, 5);
  });

  it('resample is a no-op at equal rates', () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it('floatToPcm16 clamps and scales', () => {
    const out = floatToPcm16(new Float32Array([-1, 0, 1, 0.5]));
    expect(out[0]).toBe(-32768);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(32767);
    expect(out[3]).toBeGreaterThan(16000);
  });
});

describe('OpusToPcm16', () => {
  it('decodes real Opus frames to mono PCM16 at 16kHz', async () => {
    const frames = await loadFixture();
    const decoder = new OpusToPcm16();
    await decoder.ready;
    const out = await decoder.decode(frames[0]!, 16000);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBeGreaterThan(0);
    // 20ms at 48k = 960 samples -> 320 samples at 16k. The first frame of a
    // stream can be larger due to pre-skip padding, so assert a sane floor.
    expect(out.length).toBeGreaterThanOrEqual(320);
    // A 440Hz sine must actually contain audio energy, not silence.
    let energy = 0;
    for (const s of out) energy += Math.abs(s);
    expect(energy).toBeGreaterThan(out.length * 100);
    await decoder.close();
  }, 30000);

  it('returns empty Int16Array for corrupt packets instead of throwing', async () => {
    const decoder = new OpusToPcm16();
    await decoder.ready;
    let out: Int16Array;
    await expect(
      (async () => {
        out = await decoder.decode(Buffer.from([0xff, 0xff, 0xff, 0x00, 0x01]), 16000);
      })(),
    ).resolves.toBeUndefined();
    expect(out!).toBeInstanceOf(Int16Array);
    expect(out!.length).toBe(0);
    await decoder.close();
  });
});