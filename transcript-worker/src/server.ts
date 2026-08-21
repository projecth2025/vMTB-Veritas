import http from 'node:http';
import logger from './logger.js';
import { verifyPushAuth } from './auth.js';
import type { Outcome } from './worker.js';
import type { Config } from './config.js';

const MAX_BODY_BYTES = 1_000_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_\-./]{1,128}$/;

export interface ServerDeps {
  /** Runs the whole post-meeting job. Injected so the HTTP layer is testable. */
  process: (meetingId: string) => Promise<Outcome>;
}

interface PushMessage {
  event?: string;
  meeting_id?: string;
}

/**
 * HTTP server for the transcript worker.
 *   GET  /health          liveness
 *   POST /pubsub/push     Pub/Sub push endpoint (Bearer-token protected)
 */
export function createServer(config: Config, deps: ServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200);
      res.end('OK');
      return;
    }

    if (req.method === 'POST' && url === '/pubsub/push') {
      await handlePush(req, res, config, deps);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });
}

async function handlePush(req: http.IncomingMessage, res: http.ServerResponse, config: Config, deps: ServerDeps): Promise<void> {
  if (!verifyPushAuth(req.headers, config.pubsubPushToken)) {
    logger.warn('push: unauthorized delivery rejected');
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  let body: string;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'push: body too large');
    res.writeHead(413);
    res.end('Payload Too Large');
    return;
  }

  let parsed: { message?: { data?: string } };
  try {
    parsed = JSON.parse(body) as { message?: { data?: string } };
  } catch {
    logger.warn('push: invalid JSON body');
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  let payload: PushMessage;
  try {
    const raw = parsed.message?.data ?? '';
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as PushMessage;
  } catch {
    logger.warn('push: could not decode message data');
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (payload.event !== 'meeting.completed') {
    logger.info({ event: payload.event }, 'push: ignoring non-meeting.completed event');
    res.writeHead(200);
    res.end('OK');
    return;
  }

  const meetingId = payload.meeting_id;
  if (!meetingId || !SESSION_ID_PATTERN.test(meetingId)) {
    logger.warn({ meetingId }, 'push: invalid meeting_id');
    res.writeHead(200);
    res.end('OK');
    return;
  }

  try {
    const outcome = await deps.process(meetingId);
    logger.info({ meetingId, outcome: outcome.kind }, 'push: processed');
    // Ack every outcome: failed meetings are marked FAILED, retrying won't help.
    res.writeHead(200);
    res.end('OK');
  } catch (err) {
    // Claim/DB failure -> nack so Pub/Sub redelivers.
    logger.error({ meetingId, err: err instanceof Error ? err.message : String(err) }, 'push: infra failure, nacking');
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}