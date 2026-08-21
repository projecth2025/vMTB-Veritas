import { describe, expect, it, vi } from 'vitest';
import { SupabaseStore } from '../src/store/supabase.js';
import type { TranscriptEvent } from '../src/stt/types.js';

function makeEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    meetingId: 'm1',
    participantId: 'p1',
    startTime: 10,
    endTime: 12.5,
    text: 'hello world',
    isFinal: true,
    provider: 'test',
    ...overrides,
  };
}

function makeMockSupabase() {
  const rpc = vi.fn().mockResolvedValue({ error: null, data: null });
  const from = vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
  return { rpc, from };
}

describe('SupabaseStore', () => {
  it('calls ensure_meeting_transcript', async () => {
    const mock = makeMockSupabase();
    const store = new SupabaseStore('http://localhost', 'service-key', mock as never);
    await store.ensureMeeting('m1');
    expect(mock.rpc).toHaveBeenCalledWith('ensure_meeting_transcript', { p_meeting_id: 'm1' });
  });

  it('inserts final segments', async () => {
    const mock = makeMockSupabase();
    const store = new SupabaseStore('http://localhost', 'service-key', mock as never);
    await store.insertFinalSegment(makeEvent());
    const inserted = mock.from('meeting_transcript_segments').insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      meeting_id: 'm1',
      participant_id: 'p1',
      start_time: 10,
      end_time: 12.5,
      text: 'hello world',
      is_final: true,
      provider: 'test',
    });
  });

  it('ignores interim events', async () => {
    const mock = makeMockSupabase();
    const store = new SupabaseStore('http://localhost', 'service-key', mock as never);
    await store.insertFinalSegment(makeEvent({ isFinal: false }));
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('ignores empty transcripts', async () => {
    const mock = makeMockSupabase();
    const store = new SupabaseStore('http://localhost', 'service-key', mock as never);
    await store.insertFinalSegment(makeEvent({ text: '   ' }));
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('never throws on Supabase errors (isolation from real-time path)', async () => {
    const mock = makeMockSupabase();
    mock.from.mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) });
    const store = new SupabaseStore('http://localhost', 'service-key', mock as never);
    await expect(store.insertFinalSegment(makeEvent())).resolves.toBeUndefined();

    mock.rpc.mockResolvedValue({ error: { message: 'boom' } });
    await expect(store.ensureMeeting('m1')).resolves.toBeUndefined();
  });
});