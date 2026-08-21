// Local dev helper: simulate the Jitsi Video Bridge speaking the bridge-based
// transcription protocol to the opus-transcriber-proxy, WITHOUT needing a real
// Jitsi VM.
//
// It connects to the proxy, announces a participant, streams real Opus frames
// (from the test fixture generated with ffmpeg) for ~4 seconds, prints every
// transcription-result it gets back, then closes the socket — which triggers
// the proxy's meeting.completed → Pub/Sub → worker chain.
//
// Usage:
//   PROXY_WS_URL=ws://localhost:8080/transcribe npm run simulate:jvb
//   SESSION_ID=my-room-123 npm run simulate:jvb
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PROXY_WS_URL = process.env.PROXY_WS_URL ?? 'ws://localhost:8080/transcribe';
const SESSION_ID = process.env.SESSION_ID ?? `local-test-${Date.now()}`;
// 5 fixture frames * 20ms each * 40 loops = 200 frames = 4s of audio (the dummy
// STT provider needs >1.6s to emit a final result).
const FRAME_LOOPS = Number(process.env.FRAME_LOOPS ?? '40');
const PROVIDER = process.env.PROVIDER ?? 'self-hosted';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const frames = readFileSync(join(fixturesDir, 'sine_opus_frames.b64'), 'utf8')
  .split('\n')
  .filter(Boolean);

const ws = new WebSocket(
  `${PROXY_WS_URL}?sessionId=${encodeURIComponent(SESSION_ID)}&provider=${encodeURIComponent(PROVIDER)}`,
);

let results = 0;
let finished = false;

const finish = (code: number, reason?: string) => {
  if (finished) return;
  finished = true;
  if (reason) console.log(`\n[simulate-jvb] ${reason}`);
  console.log(`[simulate-jvb] received ${results} transcription-result(s)`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
};

const timeout = setTimeout(() => finish(1, 'timed out'), 120000);

ws.on('open', () => {
  console.log(`[simulate-jvb] connected to ${PROXY_WS_URL}`);
  console.log(`[simulate-jvb] sessionId=${SESSION_ID} provider=${PROVIDER}`);

  ws.send(JSON.stringify({ event: 'ping', id: 1 }));
  ws.send(JSON.stringify({ event: 'start', start: { tag: 'participant-1' } }));

  // Stream ~4s of real Opus audio (20ms frames).
  let sent = 0;
  const sendNext = () => {
    if (sent >= frames.length * FRAME_LOOPS) {
      setTimeout(() => finish(0, 'audio sent, closing session'), 2000);
      return;
    }
    const frame = frames[sent % frames.length]!;
    ws.send(
      JSON.stringify({
        event: 'media',
        media: { tag: 'participant-1', chunk: sent, timestamp: sent * 20, payload: frame },
      }),
    );
    sent++;
    setTimeout(sendNext, 20);
  };
  sendNext();
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.event === 'pong') {
    console.log('[simulate-jvb] pong received');
    return;
  }
  if (msg.type === 'transcription-result') {
    results++;
    const kind = msg.is_interim ? 'interim' : 'FINAL';
    const text = msg.transcript?.map((t: { text?: string }) => t.text ?? '').join('') ?? '';
    console.log(`[simulate-jvb] ${kind}: "${text}"`);
  }
});

ws.on('error', (err) => finish(1, `ws error: ${err.message}`));

clearTimeout(timeout); // keep a reference so the timer doesn't keep the loop alive early
setTimeout(() => {}, 0);