import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.transcript', '*.segments[*].text', '*.mom', 'authorization', 'llmApiKey', '*.llmApiKey'],
    censor: '[redacted]',
  },
});

export default logger;