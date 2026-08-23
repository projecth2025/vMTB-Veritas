import { describe, expect, it, vi } from 'vitest';
import { buildArtifact, processMeeting } from '../src/worker.js';
import type { WorkerDeps } from '../src/worker.js';
import type { SegmentRow } from '../src/supabase.js';
import type { GcsClient } from '../src/gcs.js';

const segments: SegmentRow[] = [
  {
    meeting_id: 'm1',
    participant_id: 'p1',
    start_time: 10,
    end_time: 12,
    text: 'hello world',
    provider: 'self-hosted',
    created_at: '2026-08-20T00:00:00Z',
  },
  {
    meeting_id: 'm1',
    participant_id: 'p2',
    start_time: 12,
    end_time: 15,
    text: 'second speaker',
    provider: 'self-hosted',
    created_at: '2026-08-20T00:00:01Z',
  },
];

function makeDeps(overrides: Partial<WorkerDeps> = {}): { deps: WorkerDeps; fakes: Record<string, ReturnType<typeof vi.fn>> } {
  const fakes = {
    claim: vi.fn().mockResolvedValue({ meeting_id: 'm1', status: 'PENDING', transcript_object_key: null, error_message: null }),
    fetchSegments: vi.fn().mockResolvedValue(segments),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue(undefined),
  };
  const gcs: GcsClient = { upload: fakes.upload };
  const deps: WorkerDeps = {
    supabase: {
      claim: fakes.claim,
      fetchSegments: fakes.fetchSegments,
      complete: fakes.complete,
      fail: fakes.fail,
    } as never,
    gcs,
    llm: { provider: 'none', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
    ...overrides,
  };
  return { deps, fakes };
}

describe('processMeeting', () => {
  it('completes the happy path: claim -> segments -> GCS -> complete', async () => {
    const { deps, fakes } = makeDeps();
    const outcome = await processMeeting('m1', deps, () => 1751979219000);

    expect(outcome).toEqual({ kind: 'completed' });
    expect(fakes.claim).toHaveBeenCalledWith('m1');
    expect(fakes.fetchSegments).toHaveBeenCalledWith('m1');
    expect(fakes.upload).toHaveBeenCalledTimes(2);
    expect(fakes.upload).toHaveBeenCalledWith(
      'meetings/m1/transcript/transcript-v1.json',
      expect.stringContaining('hello world'),
      'application/json',
    );
    expect(fakes.upload).toHaveBeenCalledWith(
      'meetings/m1/transcript/transcript-v1.txt',
      '[Speaker 1] hello world [Speaker 2] second speaker',
      'text/plain',
    );
    expect(fakes.complete).toHaveBeenCalledWith('m1', 'meetings/m1/transcript/transcript-v1.json', 1, null);
    expect(fakes.fail).not.toHaveBeenCalled();
  });

  it('acks (already-processed) when no PENDING row exists', async () => {
    const { deps, fakes } = makeDeps();
    fakes.claim.mockResolvedValue(null);
    const outcome = await processMeeting('m1', deps);
    expect(outcome).toEqual({ kind: 'already-processed' });
    expect(fakes.fetchSegments).not.toHaveBeenCalled();
    expect(fakes.complete).not.toHaveBeenCalled();
  });

  it('marks FAILED and acks when GCS upload fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.upload.mockRejectedValue(new Error('storage quota exceeded'));
    const outcome = await processMeeting('m1', deps);
    expect(outcome).toEqual({ kind: 'failed', error: 'storage quota exceeded' });
    expect(fakes.fail).toHaveBeenCalledWith('m1', 'storage quota exceeded');
    expect(fakes.complete).not.toHaveBeenCalled();
  });

  it('marks FAILED and acks when the LLM step fails', async () => {
    const { deps, fakes } = makeDeps();
    const deps2 = {
      ...deps,
      llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('LLM unreachable')) as never;
    try {
      const outcome = await processMeeting('m1', deps2);
      expect(outcome).toEqual({ kind: 'failed', error: 'LLM unreachable' });
      expect(fakes.fail).toHaveBeenCalled();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('rethrows (nack) when the claim itself fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.claim.mockRejectedValue(new Error('db down'));
    await expect(processMeeting('m1', deps)).rejects.toThrow('db down');
    expect(fakes.fail).not.toHaveBeenCalled();
  });

  it('invokes the LLM when configured and passes the MoM to complete', async () => {
    const { deps, fakes } = makeDeps({
      llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'The team reviewed the case.',
                decisions: ['Proceed with therapy A'],
                action_items: [{ owner: 'Dr X', task: 'Order NGS' }],
                discussion_points: ['Option B discussed'],
              }),
            },
          },
        ],
      }),
    }) as never;
    try {
      const outcome = await processMeeting('m1', deps);
      expect(outcome).toEqual({ kind: 'completed' });
      const mom = fakes.complete.mock.calls[0]![3];
      expect(mom).toMatchObject({ summary: 'The team reviewed the case.', model: 'gpt-4o-mini' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('buildArtifact', () => {
  it('builds a versioned artifact with speaker labels and ordered text', () => {
    const artifact = buildArtifact('m1', segments, () => 1751979219000);
    expect(artifact.schema).toBe('vmtb-transcript/1');
    expect(artifact.version).toBe(1);
    expect(artifact.meeting_id).toBe('m1');
    expect(artifact.segment_count).toBe(2);
    // p1 appears first -> Speaker 1; p2 second -> Speaker 2
    expect(artifact.segments[0]!.speaker).toBe('Speaker 1');
    expect(artifact.segments[1]!.speaker).toBe('Speaker 2');
    expect(artifact.text).toBe('[Speaker 1] hello world [Speaker 2] second speaker');
    expect(artifact.generated_at).toBe(new Date(1751979219000).toISOString());
  });

  it('handles empty segment lists', () => {
    const artifact = buildArtifact('m1', [], () => 1);
    expect(artifact.segment_count).toBe(0);
    expect(artifact.text).toBe('');
  });
});