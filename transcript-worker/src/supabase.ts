import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import logger from './logger.js';

export interface MeetingTranscriptRow {
  meeting_id: string;
  status: string;
  transcript_object_key: string | null;
  error_message: string | null;
}

export interface SegmentRow {
  meeting_id: string;
  participant_id: string;
  start_time: number | null;
  end_time: number | null;
  text: string;
  provider: string | null;
  created_at: string;
}

export class SupabaseStore {
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  /** Atomically claim a PENDING meeting. Returns null when no PENDING row exists. */
  async claim(meetingId: string): Promise<MeetingTranscriptRow | null> {
    const { data, error } = await this.client.rpc('claim_meeting_transcript', { p_meeting_id: meetingId });
    if (error) throw new Error(`claim_meeting_transcript: ${error.message}`);
    if (!data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return row as MeetingTranscriptRow;
  }

  async fetchSegments(meetingId: string): Promise<SegmentRow[]> {
    const { data, error } = await this.client
      .from('meeting_transcript_segments')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('start_time', { ascending: true });
    if (error) throw new Error(`fetch segments: ${error.message}`);
    return (data ?? []) as SegmentRow[];
  }

  async complete(meetingId: string, objectKey: string, version: number, mom: unknown): Promise<void> {
    const { error } = await this.client.rpc('complete_meeting_transcript', {
      p_meeting_id: meetingId,
      p_object_key: objectKey,
      p_version: version,
      p_mom: mom ?? null,
    });
    if (error) throw new Error(`complete_meeting_transcript: ${error.message}`);
  }

  async fail(meetingId: string, errorMessage: string): Promise<void> {
    const { error } = await this.client.rpc('fail_meeting_transcript', {
      p_meeting_id: meetingId,
      p_error_message: errorMessage.slice(0, 2000),
    });
    if (error) {
      logger.warn({ err: error.message, meetingId }, 'store: fail_meeting_transcript failed');
    }
  }
}