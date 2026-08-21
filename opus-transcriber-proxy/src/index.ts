import 'dotenv/config';
import { loadConfig } from './config.js';
import logger from './logger.js';
import { createServer } from './server.js';
import { SupabaseStore } from './store/supabase.js';
import { PubSubPublisher } from './store/pubsub.js';
import type { TranscriptEvent } from './stt/types.js';

const config = loadConfig();

logger.level = config.logLevel;

// Persistence + event publishing. Both are isolated from the real-time path:
// a failure here is logged, never thrown, so transcription never breaks a meeting.
const store =
  config.persistence === 'supabase'
    ? new SupabaseStore(config.supabaseUrl, config.supabaseServiceRoleKey)
    : null;

const publisher = new PubSubPublisher(config.gcpProjectId, config.pubsubTopic);

if (config.pubsubEmulatorHost) {
  process.env.PUBSUB_EMULATOR_HOST = config.pubsubEmulatorHost;
  logger.info({ host: config.pubsubEmulatorHost }, 'pubsub: using emulator');
}

if (!store) {
  logger.warn('persistence: disabled (PERSISTENCE=none), segments will not be stored');
}

const { server, stats, close } = createServer(config, {
  // Only final segments are persisted; the store ignores interim events.
  onTranscription: (event: TranscriptEvent) => {
    if (store) {
      void store.insertFinalSegment(event);
    }
  },
  onSessionClosed: (sessionId) => {
    if (store) {
      void store.ensureMeeting(sessionId);
    }
    void publisher.publishMeetingCompleted(sessionId, null);
  },
});

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, provider: config.provider, persistence: config.persistence },
    'opus-transcriber-proxy started',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { stats };