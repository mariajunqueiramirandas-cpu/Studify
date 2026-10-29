/// <reference types="jest" />
import { jobView } from '../jobs';
import { formatDuration } from '../time';
import { essayGradeFailure, LOST_GRADING_MS } from '../../camera/api';
import type { AiJob } from '../../subjects/api';

jest.mock('../../../api/supabase', () => ({ supabase: {} }));
jest.mock('../../../api/realtime', () => ({ useJob: jest.fn() }));
jest.mock('../../../api/functions', () => ({ callFunction: jest.fn(), streamFunction: jest.fn() }));
jest.mock('../../../api/storage', () => ({ uploadFile: jest.fn() }));
jest.mock('../../auth/session', () => ({ useSession: () => ({ userId: null }) }));
jest.mock('../../../lib/kv', () => ({ getKv: () => ({ getString: () => undefined, set: () => undefined, remove: () => undefined }) }));

const job = (over: Partial<AiJob>): AiJob => ({
  id: 'j1',
  type: 'podcast.generate',
  stage: 'script',
  status: 'running',
  items_total: null,
  items_done: null,
  progress: null,
  error_code: null,
  subject_id: 's1',
  started_at: '2026-10-29T10:00:05Z',
  created_at: '2026-10-29T10:00:00Z',
  updated_at: '2026-10-29T10:00:05Z',
  ...over,
});

describe('wait times', () => {
  it('reads short and stays short as the wait grows', () => {
    expect(formatDuration(8)).toBe('8 s');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(80)).toBe('1 min 20 s');
    expect(formatDuration(200)).toBe('3 min');
    expect(formatDuration(-3)).toBe('0 s');
  });
});

describe('job view', () => {
  it('names the step and fills the bar only with progress the server reported', () => {
    const view = jobView(job({ stage: 'audio', progress: 0.8 }))!;
    expect(view).toMatchObject({ active: true, detail: 'Vozes', fraction: 0.8, startedAt: '2026-10-29T10:00:05Z' });
    // One long call reports nothing: the bar glides instead of sitting at a made-up share.
    expect(jobView(job({ type: 'pp.generate', stage: 'generate', progress: 0 }))!.fraction).toBeNull();
    expect(jobView(job({ status: 'queued', progress: 0.1 }))).toMatchObject({ queued: true, fraction: null });
  });

  it('says what went wrong when the job failed', () => {
    expect(jobView(job({ status: 'failed', error_code: 'budget_exceeded' }))).toMatchObject({ failed: true, active: false, error: expect.stringMatching(/limite|hoje/i) });
    expect(jobView(job({ status: 'failed', error_code: 'interrupted' }))!.error).toMatch(/reiniciou/);
    expect(jobView(undefined)).toBeNull();
  });
});

describe('essay grading failures', () => {
  const now = new Date().toISOString();
  it('offers to grade again a failed, a never-sent or a lost grading', () => {
    expect(essayGradeFailure({ status: 'failed', updated_at: now })).toBeTruthy();
    expect(essayGradeFailure({ status: 'draft', updated_at: now })).toMatch(/ainda não foi corrigida/);
    expect(essayGradeFailure({ status: 'grading', updated_at: new Date(Date.now() - LOST_GRADING_MS - 1000).toISOString() })).toMatch(/reiniciou/);
    expect(essayGradeFailure({ status: 'grading', updated_at: now }, true)).toMatch(/reiniciou/);
  });

  it('waits on a grading in progress and on a graded essay shows nothing', () => {
    expect(essayGradeFailure({ status: 'grading', updated_at: now })).toBeNull();
    expect(essayGradeFailure({ status: 'graded', updated_at: now })).toBeNull();
  });
});
