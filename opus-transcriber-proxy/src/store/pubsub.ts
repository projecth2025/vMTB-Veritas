import { PubSub } from '@google-cloud/pubsub';
import logger from '../logger.js';

// Publishes `meeting.completed` events to a Google Cloud Pub/Sub topic when a
// JVB transcription session closes. The message carries identifiers only —
// never transcript text.

export interface MeetingCompletedMessage {
  event: 'meeting.completed';
  meeting_id: string;
  mtb_id: string | null;
}

export class PubSubPublisher {
  private pubsub: PubSub | null = null;
  private topicName: string | null = null;

  /**
   * @param projectId GCP project id (or null to disable publishing)
   * @param topic Pub/Sub topic, e.g. "meeting-transcripts" (or null to disable)
   */
  constructor(projectId: string | null, topic: string | null) {
    if (projectId && topic) {
      this.pubsub = new PubSub({ projectId });
      this.topicName = topic;
    }
  }

  get enabled(): boolean {
    return this.pubsub !== null && this.topicName !== null;
  }

  /**
   * Publish a meeting.completed event. Failures are logged and swallowed so a
   * Pub/Sub outage can never break the real-time meeting path.
   */
  async publishMeetingCompleted(meetingId: string, mtbId: string | null): Promise<void> {
    if (!this.enabled || !this.pubsub || !this.topicName) {
      logger.debug({ meetingId }, 'pubsub: publishing disabled, skipping');
      return;
    }
    const message: MeetingCompletedMessage = {
      event: 'meeting.completed',
      meeting_id: meetingId,
      mtb_id: mtbId,
    };
    try {
      const topic = this.pubsub.topic(this.topicName);
      const messageId = await topic.publishMessage({ json: message });
      logger.info({ meetingId, messageId }, 'pubsub: published meeting.completed');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), meetingId },
        'pubsub: failed to publish meeting.completed',
      );
    }
  }
}