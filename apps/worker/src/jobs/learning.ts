// Learning-state jobs (learning-engine §2.5, §5, LRN-01.4): mastery.recompute, srs.optimize_params,
// notes.prefetch_deep. All numbers come from @studify/shared; this file reads, computes and writes.
import { z } from 'zod';
import { ancestorsOf, dropUndonePairs, type ReviewLog } from '@studify/shared';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { IN_CHUNK, chunk, fetchAll, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { computeMasteries, loadLearningData, paramsFor, userSubjectIds, type LearningData } from '../lib/learning-state.ts';
import { localDateOf, safeTimeZone } from '../lib/time.ts';

/** Mastery shift threshold (learning-engine §5.5). */
export const MASTERY_SHIFT = 0.15;
/** Minimum valid review logs before a personal FSRS optimization is considered (MEM-02.14). */
export const OPTIMIZER_MIN_LOGS = 1000;
/** Early reviews within this window of the previous review of the same card are not evidence (§2.5). */
export const EARLY_WINDOW_MS = 10 * 60_000;

const MasteryPayload = z.object({ user_id: z.string().min(1), node_ids: z.array(z.string().min(1)).max(500).default([]) });
const OptimizePayload = z.object({ user_id: z.string().min(1).optional() });

export interface MasteryResultSummary {
  updated: number;
  shifted: string[];
  replanQueued: boolean;
}

async function previousMasteries(ctx: JobContext, userId: string, nodeIds: readonly string[]): Promise<Map<string, number | null>> {
  const rows: Array<{ node_id: string; mastery: number | null }> = [];
  for (const part of chunk(nodeIds, IN_CHUNK)) {
    rows.push(...unwrapRows<{ node_id: string; mastery: number | null }>(await ctx.supabase.from('mastery').select('node_id,mastery').eq('user_id', userId).in('node_id', part), 'mastery'));
  }
  return new Map(rows.map((r) => [r.node_id, r.mastery] as const));
}

/**
 * mastery.recompute: rolls the user's evidence up to the requested nodes and their ancestors, writes
 * `mastery` rows, and queues a replan (debounced) when an in-scope topic moved by ≥ 0.15 (§5.5).
 */
export async function handleMasteryRecompute(ctx: JobContext, data: Record<string, unknown>): Promise<MasteryResultSummary> {
  const payload = MasteryPayload.parse(data);
  const profile = unwrap(
    await ctx.supabase.from('profiles').select('timezone,settings').eq('id', payload.user_id).is('deleted_at', null).maybeSingle(),
    'profiles',
  ) as { timezone: string | null; settings: Record<string, unknown> | null } | null;
  if (!profile) return { updated: 0, shifted: [], replanQueued: false };
  const timeZone = safeTimeZone(profile.timezone);
  const memory = profile.settings?.memory as { desired_retention?: number } | undefined;
  const retention = typeof memory?.desired_retention === 'number' ? memory.desired_retention : null;

  const requestedSubjects = payload.node_ids.length
    ? unwrapRows<{ subject_id: string }>(await ctx.supabase.from('knowledge_nodes').select('subject_id').in('id', payload.node_ids), 'knowledge_nodes').map((r) => r.subject_id)
    : [];
  const subjectIds = uniq([...(await userSubjectIds(ctx, payload.user_id)), ...requestedSubjects]);
  const learning: LearningData = await loadLearningData(ctx, payload.user_id, subjectIds);
  const now = ctx.now();
  const masteries = computeMasteries(learning, now, paramsFor(retention, timeZone));

  const affected = payload.node_ids.length
    ? uniq(payload.node_ids.flatMap((id) => [id, ...ancestorsOf(id, learning.parentOf)])).filter((id) => learning.nodes.has(id))
    : [...masteries.keys()].filter((id) => learning.nodes.has(id));
  if (affected.length === 0) return { updated: 0, shifted: [], replanQueued: false };

  const previous = await previousMasteries(ctx, payload.user_id, affected);
  const lastEvidence = new Map<string, Date>();
  for (const point of learning.evidence) {
    for (const id of [point.nodeId, ...ancestorsOf(point.nodeId, learning.parentOf)]) {
      const current = lastEvidence.get(id);
      if (!current || point.occurredAt > current) lastEvidence.set(id, point.occurredAt);
    }
  }

  // mastery.mastery is NOT NULL (0–1): nodes with no evidence or cards have no row (data-model §5.4).
  const rows = affected.filter((id) => (masteries.get(id)?.mastery ?? null) !== null).map((id) => {
    const m = masteries.get(id);
    return {
      user_id: payload.user_id,
      node_id: id,
      subject_id: learning.nodes.get(id)?.subjectId ?? null,
      mastery: m?.mastery ?? null,
      retrievability: m?.retrievability ?? null,
      evidence_count: m?.evidenceCount ?? 0,
      last_evidence_at: lastEvidence.get(id)?.toISOString() ?? null,
      updated_at: now.toISOString(),
    };
  });
  for (const part of chunk(rows, 200)) {
    unwrap(await ctx.supabase.from('mastery').upsert(part, { onConflict: 'user_id,node_id' }), 'mastery upsert');
  }

  const shifted = affected.filter((id) => {
    const before = previous.get(id);
    const after = masteries.get(id)?.mastery ?? null;
    return learning.nodes.get(id)?.kind === 'topic' && before !== null && before !== undefined && after !== null && Math.abs(after - before) >= MASTERY_SHIFT;
  });
  let replanQueued = false;
  if (shifted.length > 0) {
    const scheduled = unwrapRows<{ id: string }>(
      await ctx.supabase.from('exams').select('id').eq('user_id', payload.user_id).eq('status', 'scheduled').is('deleted_at', null),
      'exams',
    ).map((e) => e.id);
    const scopeNodes = scheduled.length
      ? unwrapRows<{ node_id: string }>(await ctx.supabase.from('exam_scope_nodes').select('node_id').in('exam_id', scheduled), 'exam_scope_nodes').map((r) => r.node_id)
      : [];
    const inScope = scopeNodes.length === 0 || shifted.some((id) => scopeNodes.includes(id));
    if (inScope) {
      await ctx.enqueue('plan.recompute', { user_id: payload.user_id, trigger: 'mastery_shift' }, {
        singletonKey: `plan.recompute:${payload.user_id}`,
        startAfter: new Date(now.getTime() + 30_000),
      });
      replanQueued = true;
    }
  }
  return { updated: rows.length, shifted, replanQueued };
}

export interface ReviewLogRow {
  id: string;
  card_id: string;
  rating: number;
  reviewed_at: string;
  reason: string;
  undoes_log_id: string | null;
}

/**
 * Valid logs for the optimizer (§2.5): undone pairs are dropped, and "early" reviews within 10 minutes
 * of the previous review of the same card are dropped too.
 */
export function validReviewLogs(rows: readonly ReviewLogRow[]): ReviewLogRow[] {
  const logs: ReviewLog[] = rows.map((r) => ({
    id: r.id,
    cardId: r.card_id,
    rating: (r.rating >= 1 && r.rating <= 4 ? r.rating : 3) as ReviewLog['rating'],
    reviewedAt: new Date(r.reviewed_at),
    deviceId: '',
    undoesLogId: r.undoes_log_id,
    reason: r.reason === 'early' ? 'early' : 'due',
  }));
  const kept = new Set(dropUndonePairs(logs).map((l) => l.id));
  const byCard = new Map<string, ReviewLog[]>();
  for (const log of logs) {
    const list = byCard.get(log.cardId) ?? [];
    list.push(log);
    byCard.set(log.cardId, list);
  }
  const excluded = new Set<string>();
  for (const list of byCard.values()) {
    list.sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime() || (a.id < b.id ? -1 : 1));
    list.forEach((log, i) => {
      const prev = list[i - 1];
      if (log.reason === 'early' && prev && log.reviewedAt.getTime() - prev.reviewedAt.getTime() < EARLY_WINDOW_MS) excluded.add(log.id);
    });
  }
  return rows.filter((r) => kept.has(r.id) && !excluded.has(r.id));
}

export interface OptimizeOutcome {
  status: 'skipped' | 'optimizer_unavailable';
  validLogs: number;
}

/**
 * srs.optimize_params (weekly). Only users with ≥ 1,000 valid logs are considered. The FSRS weight fit
 * is not available in this worker (learning-engine §2.5: the optimizer binding is unverified), so an
 * eligible user is logged and keeps their parameters. Nothing changes silently.
 */
export async function handleSrsOptimize(ctx: JobContext, data: Record<string, unknown>): Promise<OptimizeOutcome | { status: 'fanout'; jobs: number }> {
  const payload = OptimizePayload.parse(data);
  if (!payload.user_id) {
    const users = unwrapRows<{ id: string }>(await ctx.supabase.from('profiles').select('id').is('deleted_at', null), 'profiles');
    const parts = chunk(users.map((u) => u.id), 100);
    for (const [i, part] of parts.entries()) {
      for (const userId of part) await ctx.enqueue('srs.optimize_params', { user_id: userId }, { singletonKey: `srs.optimize_params:${userId}:${i}` });
    }
    return { status: 'fanout', jobs: users.length };
  }
  const userId = payload.user_id;
  const rows = await fetchAll<ReviewLogRow>(
    (from, to) =>
      ctx.supabase
        .from('review_logs')
        .select('id,card_id,rating,reviewed_at,reason,undoes_log_id')
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: ReviewLogRow[] | null; error: { message: string } | null }>,
    'review_logs',
  );
  const valid = validReviewLogs(rows).length;
  if (valid < OPTIMIZER_MIN_LOGS) return { status: 'skipped', validLogs: valid };
  ctx.log.warn({ validLogs: valid }, 'srs.optimize_params: optimizer unavailable in the worker; parameters unchanged');
  return { status: 'optimizer_unavailable', validLogs: valid };
}

/**
 * notes.prefetch_deep (nightly, LRN-01.4): for users with an exam within 7 days, queues deep notes for
 * in-scope topics with mastery < 0.5 (or never studied) that have no deep note yet. The generation goes
 * through ingest.topic_content, which creates the Message Batch.
 */
export async function handleNotesPrefetch(ctx: JobContext): Promise<{ users: number; subjects: number; nodes: number }> {
  const now = ctx.now();
  const today = localDateOf(now, 'America/Sao_Paulo');
  const horizon = localDateOf(new Date(now.getTime() + 7 * 86_400_000), 'America/Sao_Paulo');
  const exams = unwrapRows<{ id: string; user_id: string }>(
    await ctx.supabase.from('exams').select('id,user_id').eq('status', 'scheduled').gte('local_date', today).lte('local_date', horizon).is('deleted_at', null),
    'exams',
  );
  const examsByUser = new Map<string, string[]>();
  for (const e of exams) examsByUser.set(e.user_id, [...(examsByUser.get(e.user_id) ?? []), e.id]);

  const bySubject = new Map<string, Set<string>>();
  let nodeCount = 0;
  for (const [userId, examIds] of examsByUser) {
    const scope = unwrapRows<{ node_id: string }>(await ctx.supabase.from('exam_scope_nodes').select('node_id').in('exam_id', examIds), 'exam_scope_nodes').map((r) => r.node_id);
    if (scope.length === 0) continue;
    const topics = unwrapRows<{ id: string; subject_id: string }>(
      await ctx.supabase.from('knowledge_nodes').select('id,subject_id').in('id', uniq(scope)).eq('kind', 'topic').is('deleted_at', null),
      'knowledge_nodes',
    );
    if (topics.length === 0) continue;
    const topicIds = topics.map((t) => t.id);
    const masteryOf = await previousMasteries(ctx, userId, topicIds);
    const candidates = new Set(topicIds.filter((id) => {
      const m = masteryOf.get(id);
      return m === undefined || m === null || m < 0.5;
    }));
    const deepDone = new Set<string>();
    for (const part of chunk([...candidates], IN_CHUNK)) {
      for (const row of unwrapRows<{ node_id: string }>(
        await ctx.supabase.from('notes').select('node_id').in('node_id', part).eq('depth', 'deep').in('status', ['pending', 'generating', 'ready']).is('deleted_at', null),
        'notes',
      )) deepDone.add(row.node_id);
    }
    for (const topic of topics) {
      if (!candidates.has(topic.id) || deepDone.has(topic.id)) continue;
      const set = bySubject.get(topic.subject_id) ?? new Set<string>();
      set.add(topic.id);
      bySubject.set(topic.subject_id, set);
      nodeCount++;
    }
  }
  for (const [subjectId, nodes] of bySubject) {
    await ctx.enqueue(
      'ingest.topic_content',
      { subject_id: subjectId, node_ids: [...nodes].sort(), kinds: ['notes'], depth: 'deep' },
      { singletonKey: `prefetch-deep:${subjectId}:${today}` },
    );
  }
  return { users: examsByUser.size, subjects: bySubject.size, nodes: nodeCount };
}

export const jobs: JobDefinition[] = [
  { name: 'mastery.recompute', retryLimit: 3, handler: async (ctx, data) => void (await handleMasteryRecompute(ctx, data)) },
  { name: 'srs.optimize_params', retryLimit: 1, schedule: '0 7 * * 1', handler: async (ctx, data) => void (await handleSrsOptimize(ctx, data)) },
  { name: 'notes.prefetch_deep', retryLimit: 1, schedule: '0 5 * * *', handler: async (ctx) => void (await handleNotesPrefetch(ctx)) },
];
