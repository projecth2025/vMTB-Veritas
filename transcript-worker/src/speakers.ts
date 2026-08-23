import type { SegmentRow } from './supabase.js';

/**
 * Assign stable display labels ("Speaker 1", "Speaker 2", ...) to the opaque
 * JVB participant tags, in order of first appearance.
 *
 * The bridge-based transcription protocol carries only per-audio-channel tags,
 * not display names, so numbered speakers are the honest MVP labeling. A real
 * name mapping needs correlation with meeting participant records later.
 */
export function assignSpeakers(segments: SegmentRow[]): Map<string, string> {
  const order: string[] = [];
  for (const s of [...segments].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0))) {
    const id = s.participant_id ?? '';
    if (id && !order.includes(id)) order.push(id);
  }
  return new Map(order.map((id, i) => [id, `Speaker ${i + 1}`]));
}

export function speakerLabel(labels: Map<string, string>, participantId: string | null): string {
  return (participantId && labels.get(participantId)) || 'Unknown';
}
