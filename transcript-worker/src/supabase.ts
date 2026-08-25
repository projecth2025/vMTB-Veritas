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

  /**
   * True when any analytics session (written by jitsi-frontend) has sent a
   * heartbeat recently - i.e. someone is in a meeting right now. Used as the
   * safety valve before tearing the Jitsi VM down.
   */
  async hasActiveSession(withinMinutes = 3): Promise<boolean> {
    const cutoff = new Date(Date.now() - withinMinutes * 60_000).toISOString();
    const { data, error } = await this.client
      .from('meeting_sessions')
      .select('id')
      .eq('status', 'active')
      .gte('last_heartbeat', cutoff)
      .limit(1);
    if (error) throw new Error(`hasActiveSession: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /**
   * Resolve opaque JVB transcription tags ("9f4a4375-a0") to human display
   * names using the participant records written by jitsi-frontend analytics.
   *
   * Correlation logic:
   *   - a transcription tag is the Jitsi endpoint id plus an audio-channel
   *     suffix ("-a0"), so we strip it and match participant_id directly
   *   - only participant rows whose meeting session overlaps the transcript's
   *     time window are considered (newest record wins per endpoint id)
   *
   * Returns a map keyed by the ORIGINAL tag. Missing entries / failures mean
   * "unknown" and callers fall back to "Speaker N" labels.
   */
  async resolveParticipantNames(segments: SegmentRow[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (!segments.length) return result;

    const times = segments
      .flatMap((s) => [s.start_time, s.end_time])
      .filter((t): t is number => t != null);
    if (!times.length) return result;

    // Slack of 60s on both ends to absorb clock skew between JVB and clients.
    const windowStart = new Date(Math.min(...times) * 1000 - 60_000).toISOString();
    const windowEnd = new Date(Math.max(...times) * 1000 + 60_000).toISOString();

    const tags = [...new Set(segments.map((s) => s.participant_id).filter(Boolean))] as string[];
    const baseOf = (tag: string) => tag.replace(/-[a-z]\d+$/i, '');
    const bases = [...new Set(tags.map(baseOf))];

    try {
      const { data: parts, error } = await this.client
        .from('meeting_participants')
        .select('participant_id, display_name, meeting_session_id, joined_at')
        .in('participant_id', bases)
        .not('display_name', 'is', null);
      if (error) throw new Error(error.message);

      const rows = (parts ?? []) as Array<{
        participant_id: string;
        display_name: string;
        meeting_session_id: string;
        joined_at: string;
      }>;
      if (!rows.length) return result;

      const sessionIds = [...new Set(rows.map((r) => r.meeting_session_id))];
      const { data: sessions, error: sessErr } = await this.client
        .from('meeting_sessions')
        .select('id, started_at, ended_at')
        .in('id', sessionIds);
      if (sessErr) throw new Error(sessErr.message);

      // Keep only sessions that overlap the transcript time window.
      const overlapping = new Set(
        ((sessions ?? []) as Array<{ id: string; started_at: string; ended_at: string | null }>)
          .filter((s) => s.started_at <= windowEnd && (!s.ended_at || s.ended_at >= windowStart))
          .map((s) => s.id),
      );

      // Newest record wins per endpoint id.
      const best = new Map<string, { name: string; joinedAt: string }>();
      for (const r of rows) {
        if (!overlapping.has(r.meeting_session_id)) continue;
        const prev = best.get(r.participant_id);
        if (!prev || r.joined_at > prev.joinedAt) {
          best.set(r.participant_id, { name: r.display_name, joinedAt: r.joined_at });
        }
      }

      for (const tag of tags) {
        const hit = best.get(baseOf(tag));
        result.set(tag, hit ? hit.name : null);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'store: participant name resolution failed; falling back to Speaker N labels',
      );
    }
    return result;
  }
}