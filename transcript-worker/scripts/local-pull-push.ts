// Local dev helper: bridge a real Google Cloud Pub/Sub PULL subscription to the
// local transcript-worker's /pubsub/push endpoint.
//
// Pub/Sub push subscriptions can only reach a public HTTPS URL, so a locally
// running worker can't receive pushes directly. This script pulls messages from
// a pull subscription (created on the same topic the proxy publishes to) and
// POSTs them to the local worker in the exact push-envelope format it expects.
//
//   - acks a message when the worker returns 2xx
//   - does NOT ack on 5xx (worker marks it FAILED / or infra error) so Pub/Sub
//     redelivers after the retry backoff
//
// Usage:
//   SUBSCRIPTION=meeting-transcripts-local \
//   WORKER_URL=http://localhost:8080/pubsub/push \
//   PUBSUB_PUSH_TOKEN= \
//   npm run local:pull
import { PubSub } from '@google-cloud/pubsub';

const SUBSCRIPTION = process.env.SUBSCRIPTION ?? 'meeting-transcripts-local';
const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8080/pubsub/push';
const TOKEN = process.env.PUBSUB_PUSH_TOKEN ?? '';
const POLL_MS = Number(process.env.POLL_MS ?? '5000');
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? '10');

const projectId = process.env.GCP_PROJECT_ID || undefined;
const pubsub = new PubSub(projectId ? { projectId } : undefined);
const subscription = pubsub.subscription(SUBSCRIPTION);

async function deliver(data: Buffer, ack: () => void): Promise<void> {
  // Rebuild the Pub/Sub push envelope the worker expects: {"message":{"data":"<base64>"}}
  const body = JSON.stringify({ message: { data: data.toString('base64') } });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  const res = await fetch(WORKER_URL, { method: 'POST', headers, body });
  if (res.status >= 200 && res.status < 300) {
    console.log(`[pull-push] acked (worker ${res.status})`);
    ack();
  } else {
    console.log(`[pull-push] worker returned ${res.status}; NOT acking (will redeliver)`);
  }
}

console.log(`[pull-push] pulling from "${SUBSCRIPTION}" -> ${WORKER_URL} (token: ${TOKEN ? 'set' : 'none'})`);

async function poll(): Promise<void> {
  try {
    const [messages] = await subscription.pull({ maxMessages: MAX_MESSAGES });
    if (messages.length === 0) return;
    for (const message of messages) {
      const data = message.data ?? Buffer.alloc(0);
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        console.log(`[pull-push] got message: ${JSON.stringify(parsed)}`);
      } catch {
        console.log('[pull-push] got message (non-JSON data)');
      }
      await deliver(data, () => message.ack());
    }
  } catch (err) {
    console.error('[pull-push] pull failed:', err instanceof Error ? err.message : err);
  }
}

setInterval(poll, POLL_MS);
void poll();
console.log(`[pull-push] polling every ${POLL_MS}ms — leave this running in a terminal. Ctrl+C to stop.`);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));