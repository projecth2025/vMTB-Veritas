import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import logger from '../logger.js';
import type { TranscriptEvent } from '../stt/types.js';

// Supabase persistence for final transcript segments.
// Only FINAL segments are ever persisted; interim results stay in connection
// memory (the proxy) and are never written here.
//
// A client instance can be injected for testing; production uses the standard
// service-role client (bypasses RLS, which is exactly what a trusted backend
// needs). The service role key never reaches a browser.

export class SupabaseStore {
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  /**
   * Idempotently ensure a meeting_transcripts row exists (status PENDING).
   * Must be called before any segment insert because segments FK to it.
   * Failures are logged and swallowed so transcription never blocks the meeting.
   */
  async ensureMeeting(meetingId: string): Promise<void> {
    try {
      const { error } = await this.client.rpc('ensure_meeting_transcript', { p_meeting_id: meetingId });
      if (error) {
        logger.warn({ err: error.message, meetingId }, 'store: ensure_meeting_transcript failed');
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), meetingId }, 'store: ensureMeeting exception');
    }
  }

  /**
   * Persist one final transcript segment. Non-final events are rejected.
   *
   * Live segments can race ahead of the parent meeting_transcripts row
   * (which is guaranteed at session close), hitting the FK constraint.
   * On a foreign-key violation we create the parent and retry once.
   */
  async insertFinalSegment(event: TranscriptEvent): Promise<void> {
    if (!event.isFinal) {
      logger.debug({ participantId: event.participantId }, 'store: ignoring interim segment');
      return;
    }
    if (!event.text || !event.text.trim()) return;

    const row = {
      meeting_id: event.meetingId,
      participant_id: event.participantId,
      start_time: event.startTime,
      end_time: event.endTime,
      text: event.text,
      is_final: true,
      provider: event.provider,
    };

    let { error } = await this.client.from('meeting_transcript_segments').insert(row);

    // Postgres FK violation = parent row not created yet (live insert race).
    if (error && ((error as { code?: string }).code === '23503' || /foreign key/i.test(error.message))) {
      logger.debug(
        { meetingId: event.meetingId, participantId: event.participantId },
        'store: parent meeting row missing, ensuring and retrying once',
      );
      await this.ensureMeeting(event.meetingId);
      ({ error } = await this.client.from('meeting_transcript_segments').insert(row));
    }

    if (error) {
      logger.warn({ err: error.message, meetingId: event.meetingId, participantId: event.participantId }, 'store: segment insert failed');
      return;
    }
    logger.debug(
      { meetingId: event.meetingId, participantId: event.participantId, length: event.text.length },
      'store: final segment persisted',
    );
  }
}