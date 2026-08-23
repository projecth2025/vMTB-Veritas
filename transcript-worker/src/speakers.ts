import type { SegmentRow } from './supabase.js';

/**
 * Assign stable display labels ("Speaker 1", "Speaker 2", ...) to the opaque
 * JVB participant tags, in order of first appearance.
 *
 * The bridge-based transcription protocol carries only per-audio-channel tags,
 * not display names, so numbered speakers are the honest MVP labeling. A real
 * name mapping needs correlation with meeting participant records later.
 */
/**
 * Assign display labels to participant tags, in order of first appearance.
 * When a resolved display name exists for a tag it wins; otherwise the tag
 * falls back to "Speaker N" (numbered across the whole meeting).
 */
export function assignSpeakers(
  segments: SegmentRow[],
  displayNames?: Map<string, string | null>,
): Map<string, string> {
  const order: string[] = [];
  for (const s of [...segments].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0))) {
    const id = s.participant_id ?? '';
    if (id && !order.includes(id)) order.push(id);
  }
  return new Map(
    order.map((id, i) => {
      const name = displayNames?.get(id);
      return [id, name && name.trim() ? name : `Speaker ${i + 1}`];
    }),
  );
}

export function speakerLabel(labels: Map<string, string>, participantId: string | null): string {
  return (participantId && labels.get(participantId)) || 'Unknown';
}

export interface SpeakerLine {
  speaker: string;
  text: string;
}

/**
 * Merge consecutive segments from the same speaker into single flowing
 * utterances. The streaming STT commits small fragments (with occasional
 * echo artifacts); stitching them per speaker turns the raw segment list
 * into readable paragraphs for artifacts and MoM prompts.
 */
export function groupBySpeaker(
  segments: SegmentRow[],
  labels: Map<string, string>,
): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  for (const s of [...segments].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0))) {
    const speaker = speakerLabel(labels, s.participant_id);
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${s.text}`.replace(/\s+/g, ' ').trim();
    } else {
      lines.push({ speaker, text: s.text });
    }
  }
  return lines;
}
