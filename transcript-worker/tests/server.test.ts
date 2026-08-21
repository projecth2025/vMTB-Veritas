import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer, type ServerDeps } from '../src/server.js';
import type { Config } from '../src/config.js';
import type { Outcome } from '../src/worker.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    supabaseUrl: 'http://localhost',
    supabaseServiceRoleKey: 'key',
    gcsBucket: 'bucket',
    gcpProjectId: '',
    pubsubPushToken: 'push-secret',
    llmProvider: 'none',
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: 'gpt-4o-mini',
    ...overrides,
  };
}

function makeDeps(impl?: (meetingId: string) => Promise<Outcome>): { deps: ServerDeps; process: ReturnType<typeof vi.fn> } {
  const process = vi.fn(impl ?? (async () => ({ kind: 'completed' })));
  return { deps: { process }, process };
}

async function withServer(config: Config, deps: ServerDeps, fn: (base: string) => Promise<void>) {
  const server = createServer(config, deps);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function pushBody(meetingId: string, event = 'meeting.completed') {
  return JSON.stringify({
    message: {
      messageId: 'msg-1',
      data: Buffer.from(JSON.stringify({ event, meeting_id: meetingId })).toString('base64'),
    },
  });
}

describe('server /pubsub/push', () => {
  it('acks a valid meeting.completed push and processes the meeting', async () => {
    const { deps, process } = makeDeps();
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer push-secret', 'content-type': 'application/json' },
        body: pushBody('room-123'),
      });
      expect(res.status).toBe(200);
    });
    expect(process).toHaveBeenCalledWith('room-123');
  });

  it('rejects pushes without the bearer token', async () => {
    const { deps, process } = makeDeps();
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        body: pushBody('room-123'),
      });
      expect(res.status).toBe(401);
    });
    expect(process).not.toHaveBeenCalled();
  });

  it('acks and ignores non-meeting events', async () => {
    const { deps, process } = makeDeps();
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer push-secret' },
        body: pushBody('room-123', 'something.else'),
      });
      expect(res.status).toBe(200);
    });
    expect(process).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed bodies', async () => {
    const { deps, process } = makeDeps();
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer push-secret' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });
    expect(process).not.toHaveBeenCalled();
  });

  it('returns 500 (nack) when the claim hits an infra failure', async () => {
    const { deps, process } = makeDeps(async () => {
      throw new Error('db down');
    });
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer push-secret' },
        body: pushBody('room-123'),
      });
      expect(res.status).toBe(500);
    });
    expect(process).toHaveBeenCalledWith('room-123');
  });

  it('acks failed outcomes (they are marked FAILED, retry would not help)', async () => {
    const { deps, process } = makeDeps(async () => ({ kind: 'failed', error: 'boom' }));
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/pubsub/push`, {
        method: 'POST',
        headers: { authorization: 'Bearer push-secret' },
        body: pushBody('room-123'),
      });
      expect(res.status).toBe(200);
    });
    expect(process).toHaveBeenCalled();
  });

  it('serves /health', async () => {
    const { deps } = makeDeps();
    await withServer(makeConfig(), deps, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    });
  });
});