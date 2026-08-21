import { pino } from 'pino';

// Structured logging. The proxy handles clinical meeting audio, so never log
// audio payloads, full transcript text, API keys or credentials.

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.payload',
      '*.media.payload',
      '*.transcript',
      '*.transcript[*].text',
      'supabaseServiceRoleKey',
      '*.supabaseServiceRoleKey',
    ],
    censor: '[redacted]',
  },
});

export default logger;