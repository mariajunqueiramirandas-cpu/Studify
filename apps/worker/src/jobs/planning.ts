// Planner jobs (GOL-03, GOL-04, GOL-07, GOL-08, GOL-11): plan.recompute, plan.nightly,
// vespera.prepare and scope.match. Planning is code (@studify/shared buildPlan, predictedGrade,
// readiness). AI runs only for the véspera cheat sheet and the scope fallback.
import { z } from 'zod';
import {
  buildPlan,
  buildVespera,
  estLearnMinutes,
  predictedGrade,
  readiness,
  wallTimeToInstant,
  type PlanRun,
  type PredictionTopic,
  type ReplanTrigger,
  type VesperaExam,
  type VesperaScopeTopic,
} from '@studify/shared';
import { Cheatsheet, ScopeMatch, scopeMatch, vesperaCheatsheet, type CheatsheetInput, type ScopeMatchInput } from '@studify/prompts';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { runPrompt, type AiScope } from '../lib/ai-adapter.ts';
import { JobDataError, chunk, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { computeMasteries, type NodeInfo } from '../lib/learning-state.ts';
import { buildPlanInput, carryOverDone, planItemRows, planRunRecord, plannerTriggerOf, topicOf, type PlanItemRow } from '../lib/plan-data.ts';
import { loadPlanContext, type PlanContext } from '../lib/plan-context.ts';
import { wallClockOf } from '@studify/shared';
import { addDays, localHour, safeTimeZone } from '../lib/time.ts';

const PlanPayload = z.object({ user_id: z.string().min(1), trigger: z.string().min(1).default('nightly') });
const NightlyPayload = z.object({ user_ids: z.array(z.string().min(1)).max(500).optional() });
const VesperaPayload = z.object({ exam_id: z.string().min(1), user_id: z.string().min(1) });
const ScopePayload = z.object({ exam_id: z.string().min(1) });

export interface ReplanResult {
  status: 'unchanged' | 'planned';
  version?: number;
  reorganized?: boolean;
  movedMinutes?: number;
  items?: number;
}

/** Scope topics per exam: confirmed rows (or default_all), else every non-excluded topic of the subject (GOL-03.5). */
export function scopeTopicsByExam(planCtx: PlanContext): Map<string, string[]> {
  const nodeById = new Map(planCtx.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, string[]>();
  for (const exam of planCtx.exams) {
    const confirmed = planCtx.scope.filter((s) => s.exam_id === exam.id && (s.confirmed || s.source === 'default_all'));
    let topics = uniq(confirmed.map((s) => topicOf(s.node_id, nodeById)).filter((t): t is string => t !== null));
    if (topics.length === 0) {
      topics = planCtx.nodes
        .filter((n) => n.kind === 'topic' && n.subjectId === exam.subject_id && !planCtx.excludedNodeIds.has(n.id))
        .map((n) => n.id);
    }
    out.set(exam.id, topics.sort());
  }
  return out;
}

/** ω per in-scope topic (learning-engine §11.1): est_learn_minutes share over the test's scope. */
export function scopeWeights(planCtx: PlanContext, topicIds: readonly string[]): Array<{ id: string; weight: number }> {
  const minutes = topicIds.map((id) => ({ id, m: estLearnMinutes(planCtx.sourcesByNode.get(id) ?? []) }));
  const total = minutes.reduce((acc, x) => acc + x.m, 0);
  return minutes.map((x) => ({ id: x.id, weight: total > 0 ? x.m / total : 0 }));
}

export interface ReadinessSnapshot {
  examId: string;
  scopeTopicIds: string[];
  row: {
    user_id: string;
    exam_id: string;
    local_date: string;
    readiness: number;
    readiness_proj: number | null;
    pred_low: number | null;
    pred_mid: number | null;
    pred_high: number | null;
    evidence: Record<string, unknown>;
  };
}

/** GOL-08 readiness and GOL-11 predicted grade per upcoming scheduled exam. Pure given the context. */
export function readinessFor(planCtx: PlanContext, scopeByExam: ReadonlyMap<string, string[]>): ReadinessSnapshot[] {
  const nodeById = new Map<string, NodeInfo>(planCtx.nodes.map((n) => [n.id, n] as const));
  const retention = planCtx.retention ?? 0.9;
  const out: ReadinessSnapshot[] = [];
  for (const exam of planCtx.exams) {
    if (exam.local_date < planCtx.today) continue;
    const scopeTopicIds = scopeByExam.get(exam.id) ?? [];
    const weights = scopeWeights(planCtx, scopeTopicIds);
    const nowMastery = planCtx.masteries;
    const value = readiness(
      weights.map((w) => ({ id: w.id, weight: w.weight, studied: nowMastery.get(w.id)?.studied ?? false, mastery: nowMastery.get(w.id)?.mastery ?? null })),
    );
    const atExam = computeMasteries(planCtx.learning, wallTimeToInstant(exam.local_date, 7, 0, planCtx.timeZone), planCtx.params);
    const topics: PredictionTopic[] = weights.map((w) => {
      const now = nowMastery.get(w.id);
      const future = atExam.get(w.id);
      return {
        id: w.id,
        weight: w.weight,
        studied: now?.studied ?? false,
        lambda: now?.lambda ?? null,
        retrievabilityAtExam: future?.retrievability ?? null,
        accuracyAtExam: future?.accuracy ?? null,
        masteryNow: now?.mastery ?? null,
      };
    });
    const scopeSet = new Set(scopeTopicIds);
    const answered = planCtx.learning.evidence.filter((e) => {
      const t = topicOf(e.nodeId, nodeById);
      return t !== null && scopeSet.has(t);
    }).length;
    const grade = predictedGrade({ topics, scaleMax: 10, rTarget: retention, alpha: 0.7, answeredQuestionsInScope: answered });
    const enough = grade !== 'not_enough';
    out.push({
      examId: exam.id,
      scopeTopicIds,
      row: {
        user_id: planCtx.userId,
        exam_id: exam.id,
        local_date: planCtx.today,
        readiness: value.value,
        readiness_proj: enough ? grade.readinessProj : null,
        pred_low: enough ? grade.lo : null,
        pred_mid: enough ? grade.grade : null,
        pred_high: enough ? grade.hi : null,
        evidence: { coveredWeight: value.coveredWeight, answeredQuestions: answered, notEnough: !enough },
      },
    });
  }
  return out;
}

/** Signature of a plan: block id, day, minutes and status, for items that exist in the new run or are not done. */
export function samePlan(run: PlanRun, previous: readonly PlanItemRow[]): boolean {
  const inRun = new Set(run.items.map((i) => i.id));
  const blockOf = (row: PlanItemRow): string => (typeof row.reason_params?.blockId === 'string' ? row.reason_params.blockId : row.id);
  const sig = (block: string, day: string, minutes: number, status: string): string => `${block}|${day}|${minutes}|${status}`;
  const before = previous
    .filter((r) => r.status !== 'done' || inRun.has(blockOf(r)))
    .map((r) => sig(blockOf(r), r.local_date, r.minutes, r.status))
    .sort();
  const after = run.items.map((i) => sig(i.id, i.day, Math.round(i.minutes), i.status)).sort();
  return before.length === after.length && before.every((v, i) => v === after[i]);
}

/** Replans one user from a loaded context. Identical inputs to the last run write nothing. */
export async function replanUser(ctx: JobContext, planCtx: PlanContext, trigger: ReplanTrigger): Promise<ReplanResult> {
  const built = buildPlanInput({
    today: planCtx.today,
    timeZone: planCtx.timeZone,
    prefs: planCtx.prefs,
    exams: planCtx.exams,
    scope: planCtx.scope,
    nodes: planCtx.nodes,
    excludedNodeIds: planCtx.excludedNodeIds,
    sourcesByNode: planCtx.sourcesByNode,
    masteries: planCtx.masteries,
    exceptions: planCtx.exceptions,
    reviewMinutesByDay: planCtx.reviewMinutesByDay,
    previousItems: planCtx.previousRows,
    desperate: planCtx.desperate,
    mode: planCtx.desperate ? 'desperate' : 'normal',
  });
  const run: PlanRun = buildPlan(built.input, trigger);
  // No-op check on the resulting plan, not the input hash: the hash includes the previous items, so it
  // changes after every write. Same blocks on the same days with the same minutes → nothing new.
  if (planCtx.latestRun && samePlan(run, planCtx.previousRows)) return { status: 'unchanged' };

  const version = (planCtx.latestRun?.version ?? 0) + 1;
  const inserted = unwrap(
    await ctx.supabase.from('plan_runs').insert(planRunRecord(planCtx.userId, version, trigger, run)).select('id').single(),
    'plan_runs insert',
  ) as { id: string } | null;
  if (!inserted) throw new JobDataError('plan_runs insert returned no row', 'db_error');
  const rows = [
    ...planItemRows(planCtx.userId, inserted.id, run, built),
    ...carryOverDone(planCtx.previousRows as PlanItemRow[], run, inserted.id),
  ];
  for (const part of chunk(rows, 200)) {
    unwrap(await ctx.supabase.from('plan_items').insert(part), 'plan_items insert');
  }
  return { status: 'planned', version, reorganized: run.reorganized, movedMinutes: run.movedMinutes, items: rows.length };
}

async function planOne(ctx: JobContext, userId: string, trigger: ReplanTrigger, withReadiness: boolean): Promise<ReplanResult | null> {
  const planCtx = await loadPlanContext(ctx, userId);
  if (!planCtx) return null;
  const result = await replanUser(ctx, planCtx, trigger);
  if (withReadiness) {
    const rows = readinessFor(planCtx, scopeTopicsByExam(planCtx)).map((s) => s.row);
    if (rows.length > 0) unwrap(await ctx.supabase.from('readiness_snapshots').upsert(rows, { onConflict: 'user_id,exam_id,local_date' }), 'readiness_snapshots');
  }
  return result;
}

/** plan.recompute: debounced per user upstream (singleton key user_id, 30 s). */
export async function handlePlanRecompute(ctx: JobContext, data: Record<string, unknown>): Promise<ReplanResult | null> {
  const payload = PlanPayload.parse(data);
  const result = await planOne(ctx, payload.user_id, plannerTriggerOf(payload.trigger), false);
  if (result?.status === 'planned') ctx.log.info({ trigger: payload.trigger, version: result.version }, 'plan.recompute: planned');
  return result;
}

/**
 * plan.nightly: replans missed days and writes readiness snapshots. With no user_ids it fans out
 * (100 users per job) to the profiles whose local time is 03:xx; the hourly schedule makes that daily.
 */
export async function handlePlanNightly(ctx: JobContext, data: Record<string, unknown>): Promise<{ planned: number; unchanged: number; fanout: number }> {
  const payload = NightlyPayload.parse(data);
  if (!payload.user_ids || payload.user_ids.length === 0) {
    const profiles = unwrapRows<{ id: string; timezone: string | null }>(await ctx.supabase.from('profiles').select('id,timezone').is('deleted_at', null), 'profiles');
    const now = ctx.now();
    const due = profiles.filter((p) => localHour(now, safeTimeZone(p.timezone)) === 3).map((p) => p.id);
    const parts = chunk(due, 100);
    for (const [i, part] of parts.entries()) {
      await ctx.enqueue('plan.nightly', { user_ids: part }, { singletonKey: `plan.nightly:${now.toISOString().slice(0, 13)}:${i}` });
    }
    return { planned: 0, unchanged: 0, fanout: parts.length };
  }
  let planned = 0;
  let unchanged = 0;
  const failed: string[] = [];
  for (const userId of payload.user_ids) {
    try {
      const result = await planOne(ctx, userId, 'nightly', true);
      if (result?.status === 'planned') planned++;
      else unchanged++;
    } catch (err) {
      ctx.log.error({ err, userId }, 'plan.nightly: user failed');
      failed.push(userId);
    }
  }
  // Throwing retries the chunk; users that already planned are unchanged on the retry (input hash).
  if (failed.length > 0) throw new JobDataError(`plan.nightly: ${failed.length} user(s) failed`, 'partial_failure');
  return { planned, unchanged, fanout: 0 };
}

interface Citation {
  document_id: string;
  page_start: number;
  page_end: number;
}

function pageSetOf(citations: readonly Citation[], labelOf: (documentId: string) => string): Map<string, Set<number>> {
  const pages = new Map<string, Set<number>>();
  for (const c of citations) {
    const label = labelOf(c.document_id);
    const set = pages.get(label) ?? new Set<number>();
    for (let p = c.page_start; p <= c.page_end; p++) set.add(p);
    pages.set(label, set);
  }
  return pages;
}

function allowedRange(pages: Map<string, Set<number>>, label: string, start: number, end: number): boolean {
  const set = pages.get(label);
  if (!set || end < start) return false;
  for (let p = start; p <= end; p++) if (!set.has(p)) return false;
  return true;
}

function answerTextOf(payload: Record<string, unknown>): string {
  if (typeof payload.model_answer === 'string') return payload.model_answer;
  if (typeof payload.final_answer === 'string' || typeof payload.final_answer === 'number') return String(payload.final_answer);
  if (typeof payload.correct === 'string') {
    const options = Array.isArray(payload.options) ? (payload.options as Array<{ id: string; text: string }>) : [];
    return options.find((o) => o.id === payload.correct)?.text ?? payload.correct;
  }
  return '';
}

/**
 * vespera.prepare (GOL-07): builds the véspera session with buildVespera and writes the cheat sheet
 * (vespera.cheatsheet, standard API) onto the véspera plan item. Sections and bullets whose source
 * pages are not among the pages the notes cite are dropped (GOL-07.2).
 */
export async function handleVesperaPrepare(ctx: JobContext, data: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'GOL-07.2' }): Promise<{ status: string; examId: string; sections?: number }> {
  const payload = VesperaPayload.parse(data);
  const planCtx = await loadPlanContext(ctx, payload.user_id);
  if (!planCtx) return { status: 'no_profile', examId: payload.exam_id };
  const exam = planCtx.exams.find((e) => e.id === payload.exam_id);
  if (!exam) return { status: 'not_scheduled', examId: payload.exam_id };
  if (exam.local_date !== addDays(planCtx.today, 1)) return { status: 'not_eve', examId: exam.id };

  const scopeTopics = scopeTopicsByExam(planCtx).get(exam.id) ?? [];
  const nodeById = new Map(planCtx.nodes.map((n) => [n.id, n] as const));
  const weights = scopeWeights(planCtx, scopeTopics);
  const scopeRows: VesperaScopeTopic[] = weights.map((w) => {
    const m = planCtx.masteries.get(w.id);
    return { topicId: w.id, examId: exam.id, title: nodeById.get(w.id)?.title ?? '', weight: w.weight, studied: m?.studied ?? false, mastery: m?.mastery ?? null };
  });
  const readinessValue = readinessFor(planCtx, new Map([[exam.id, scopeTopics]])).find((r) => r.examId === exam.id)?.row.readiness ?? 0;
  const vesperaExam: VesperaExam = {
    id: exam.id,
    title: exam.title,
    localDate: exam.local_date,
    startTime: exam.starts_at ? wallClockOf(new Date(exam.starts_at), planCtx.timeZone).hour.toString().padStart(2, '0') + ':' + wallClockOf(new Date(exam.starts_at), planCtx.timeZone).minute.toString().padStart(2, '0') : null,
    weight: exam.weight && exam.weight > 0 ? exam.weight : 1,
    readiness: readinessValue,
  };

  const scopeCardIds = new Set(planCtx.learning.cards.filter((c) => c.nodeId !== null && scopeTopics.includes(topicOf(c.nodeId, nodeById) ?? '')).map((c) => c.cardId));
  const since = new Date(planCtx.now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const errorLogs = unwrapRows<{ card_id: string }>(
    await ctx.supabase.from('review_logs').select('card_id').eq('user_id', payload.user_id).eq('rating', 1).gte('reviewed_at', since),
    'review_logs',
  );
  const errorCardIds = uniq(errorLogs.map((l) => l.card_id).filter((id) => scopeCardIds.has(id))).sort();
  const mistakes = unwrapRows<{ id: string; question_id: string; node_id: string }>(
    await ctx.supabase.from('mistakes').select('id,question_id,node_id').eq('user_id', payload.user_id).is('resolved_at', null).is('deleted_at', null),
    'mistakes',
  ).filter((m) => scopeTopics.includes(topicOf(m.node_id, nodeById) ?? m.node_id));
  const mistakeIds = mistakes.map((m) => m.id).sort();

  const session = buildVespera({
    today: planCtx.today,
    exams: [vesperaExam],
    scope: scopeRows,
    errorCardIds: { [exam.id]: errorCardIds },
    unresolvedMistakeIds: { [exam.id]: mistakeIds },
    vesperaTime: (planCtx.prefs?.vespera_time ?? '19:00').slice(0, 5),
    quietStart: (planCtx.prefs?.quiet_start ?? '22:00').slice(0, 5),
    quietEnd: (planCtx.prefs?.quiet_end ?? '07:00').slice(0, 5),
  });
  if (!session) return { status: 'no_session', examId: exam.id };

  const item = unwrap(
    await ctx.supabase
      .from('plan_items')
      .select('id,reason_params')
      .eq('user_id', payload.user_id)
      .eq('exam_id', exam.id)
      .eq('unit_type', 'vespera')
      .is('deleted_at', null)
      .order('local_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'plan_items',
  ) as { id: string; reason_params: Record<string, unknown> | null } | null;
  if (!item) throw new JobDataError('no véspera plan item for this test yet', 'not_found');
  if (item.reason_params?.cheatsheet) return { status: 'already_prepared', examId: exam.id };

  // Input for the cheat sheet. Labels (D1, D2…) are assigned before the prompt is built, so every
  // label used in the input is listed in sourceDocs.
  const topicsOrdered = scopeRows
    .slice()
    .sort((a, b) => b.weight * (1 - (b.mastery ?? 0)) - a.weight * (1 - (a.mastery ?? 0)) || (a.topicId < b.topicId ? -1 : 1))
    .slice(0, 10);
  const notes = scopeTopics.length
    ? unwrapRows<{ node_id: string; body: string; citations: Citation[] | null }>(
        await ctx.supabase.from('notes').select('node_id,body,citations').in('node_id', scopeTopics).eq('depth', 'tldr').eq('status', 'ready').is('deleted_at', null),
        'notes',
      )
    : [];
  const labels = new Map<string, string>();
  const labelOf = (documentId: string): string => {
    const known = labels.get(documentId);
    if (known) return known;
    const label = `D${labels.size + 1}`;
    labels.set(documentId, label);
    return label;
  };
  const tldrPages = new Map<string, Map<string, Set<number>>>();
  const tldrText = new Map<string, string>();
  for (const note of notes) {
    const citations = note.citations ?? [];
    tldrPages.set(note.node_id, pageSetOf(citations, labelOf));
    const refs = citations.map((c) => `(${labelOf(c.document_id)} p. ${c.page_start === c.page_end ? c.page_start : `${c.page_start}–${c.page_end}`})`);
    tldrText.set(note.node_id, refs.length ? `${note.body} ${refs.join(' ')}` : note.body);
  }
  const glossary = scopeTopics.length
    ? unwrapRows<{ term: string; definition: string | null }>(
        await ctx.supabase.from('glossary_terms').select('term,definition').in('node_id', scopeTopics).is('deleted_at', null).is('hidden_reason', null).limit(30),
        'glossary_terms',
      )
    : [];
  const questions = mistakes.length
    ? unwrapRows<{ id: string; stem: string; payload: Record<string, unknown>; source_pages: Citation[] | null }>(
        await ctx.supabase.from('questions').select('id,stem,payload,source_pages').in('id', mistakes.map((m) => m.question_id)),
        'questions',
      )
    : [];
  const questionById = new Map(questions.map((q) => [q.id, q] as const));
  const unresolvedMistakes = mistakes.map((m) => {
    const q = questionById.get(m.question_id);
    return {
      id: m.id,
      stem: q?.stem ?? '',
      correctAnswer: answerTextOf(q?.payload ?? {}),
      pages: (q?.source_pages ?? []).map((c) => ({ doc: labelOf(c.document_id), page: c.page_start })),
    };
  });
  const documentIds = [...labels.keys()];
  const titles = documentIds.length
    ? new Map(unwrapRows<{ id: string; title: string }>(await ctx.supabase.from('documents').select('id,title').in('id', documentIds), 'documents').map((d) => [d.id, d.title] as const))
    : new Map<string, string>();

  const input: CheatsheetInput = {
    exam: { title: exam.title, date: exam.local_date, kind: exam.kind === 'regular' ? null : exam.kind },
    sourceDocs: documentIds.map((id) => ({ doc: labels.get(id) ?? '', title: titles.get(id) ?? '' })),
    topics: topicsOrdered.map((t) => ({ key: t.topicId, title: t.title, weight: t.weight, mastery: t.mastery ?? 0, tldr: tldrText.get(t.topicId) ?? null })),
    glossary: glossary.map((g) => ({ term: g.term, definition: g.definition ?? '' })),
    unresolvedMistakes,
    contentLanguage: 'pt-BR',
  };
  const outcome = await runPrompt(ctx.ai, {
    task: vesperaCheatsheet,
    schema: Cheatsheet,
    input,
    scope: { ...scope, userId: payload.user_id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') throw new JobDataError(`vespera.cheatsheet ${outcome.result.status}`, 'ai_failed');

  const mistakeSet = new Set(mistakeIds);
  const sections = outcome.result.data.sections
    .filter((s) => scopeTopics.includes(s.node_key))
    .map((s) => {
      const pages = tldrPages.get(s.node_key) ?? new Map<string, Set<number>>();
      return { ...s, bullets: s.bullets.filter((b) => b.source_pages.every((p) => allowedRange(pages, p.doc, p.page_start, p.page_end))) };
    })
    .filter((s) => s.bullets.length > 0);
  const watchOut = outcome.result.data.watch_out.map((w) => ({
    text: w.text,
    from_mistake_id: w.from_mistake_id && mistakeSet.has(w.from_mistake_id) ? w.from_mistake_id : null,
  }));
  const cheatsheet = { title: outcome.result.data.title, sections, watch_out: watchOut, generatedAt: planCtx.now.toISOString() };
  unwrap(
    await ctx.supabase
      .from('plan_items')
      .update({
        reason_params: {
          ...(item.reason_params ?? {}),
          cheatsheet,
          session: { totalMinutes: session.totalMinutes, minutesByExam: session.minutesByExam, notifyAt: session.notifyAt, sleepStopAt: session.sleepStopAt, parts: session.parts },
        },
      })
      .eq('id', item.id),
    'plan_items update',
  );
  return { status: 'prepared', examId: exam.id, sections: sections.length };
}

/**
 * scope.match (GOL-03 fallback): maps the stored content list to the subject's map. The mapping is
 * stored unconfirmed (source 'ai', confirmed false); the student confirms it in the scope review.
 */
export async function handleScopeMatch(ctx: JobContext, data: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'GOL-03.2' }): Promise<{ status: string; items: number }> {
  const payload = ScopePayload.parse(data);
  const exam = unwrap(
    await ctx.supabase.from('exams').select('id,user_id,subject_id,status').eq('id', payload.exam_id).is('deleted_at', null).maybeSingle(),
    'exams',
  ) as { id: string; user_id: string; subject_id: string | null; status: string } | null;
  if (!exam || exam.status !== 'scheduled') return { status: 'not_scheduled', items: 0 };
  if (!exam.subject_id) throw new JobDataError('scope.match: exam has no subject', 'no_subject');
  const stored = unwrapRows<{ raw_text: string; position: number }>(
    await ctx.supabase.from('exam_scope_items').select('raw_text,position').eq('exam_id', exam.id).order('position', { ascending: true }),
    'exam_scope_items',
  );
  if (stored.length === 0) throw new JobDataError('scope.match: no content list stored for this exam', 'no_content');

  const subject = unwrap(await ctx.supabase.from('subjects').select('content_language').eq('id', exam.subject_id).maybeSingle(), 'subjects') as { content_language: string | null } | null;
  const nodes = unwrapRows<{ id: string; kind: string; title: string; summary: string | null }>(
    await ctx.supabase.from('knowledge_nodes').select('id,kind,title,summary').eq('subject_id', exam.subject_id).is('deleted_at', null),
    'knowledge_nodes',
  );
  const excluded = new Set(
    unwrapRows<{ node_id: string }>(await ctx.supabase.from('node_user_settings').select('node_id').eq('user_id', exam.user_id).eq('excluded', true), 'node_user_settings').map((r) => r.node_id),
  );
  const outline = nodes.map((n) => ({
    key: n.id,
    kind: (n.kind === 'unit' || n.kind === 'concept' ? n.kind : 'topic') as 'unit' | 'topic' | 'concept',
    title: n.title,
    summary: (n.summary ?? '').slice(0, 200),
    excluded: excluded.has(n.id),
  }));
  const contentList: ScopeMatchInput['contentList'] = { kind: 'text', text: stored.map((s) => s.raw_text).join('\n') };

  const outcome = await runPrompt(ctx.ai, {
    task: scopeMatch,
    schema: ScopeMatch,
    input: { contentList, outline, contentLanguage: subject?.content_language ?? 'pt-BR' },
    scope: { ...scope, userId: exam.user_id, subjectId: exam.subject_id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') throw new JobDataError(`scope.match ${outcome.result.status}`, 'ai_failed');

  const known = new Set(nodes.map((n) => n.id));
  const statusOf = (c: number): 'matched' | 'partial' | 'unmatched' => (c > 0.8 ? 'matched' : c >= 0.4 ? 'partial' : 'unmatched');
  const items = outcome.result.data.items.map((item, index) => {
    const best = item.matches
      .filter((m) => known.has(m.node_key) && m.confidence >= 0.4)
      .sort((a, b) => b.confidence - a.confidence)[0];
    return { item, index, best };
  });

  // Keep whatever the student already confirmed or set by hand (source user/default_all, or confirmed).
  const existingNodes = unwrapRows<{ node_id: string; source: string; confirmed: boolean }>(
    await ctx.supabase.from('exam_scope_nodes').select('node_id,source,confirmed').eq('exam_id', exam.id),
    'exam_scope_nodes',
  );
  const kept = new Set(existingNodes.filter((r) => r.confirmed || r.source !== 'ai').map((r) => r.node_id));

  unwrap(await ctx.supabase.from('exam_scope_items').delete().eq('exam_id', exam.id), 'exam_scope_items delete');
  unwrap(
    await ctx.supabase.from('exam_scope_items').insert(
      items.map(({ item, index, best }) => ({
        exam_id: exam.id,
        raw_text: item.raw_text,
        position: index,
        status: best ? statusOf(best.confidence) : 'unmatched',
        placeholder_node_id: null,
        source_document_id: null,
      })),
    ),
    'exam_scope_items insert',
  );
  unwrap(await ctx.supabase.from('exam_scope_nodes').delete().eq('exam_id', exam.id).eq('source', 'ai').eq('confirmed', false), 'exam_scope_nodes delete');
  const nodeRows = items
    .filter((x) => x.best && !kept.has(x.best.node_key))
    .map((x) => ({ exam_id: exam.id, node_id: x.best?.node_key ?? '', scope_item_id: null, source: 'ai', confidence: x.best?.confidence ?? 0, confirmed: false }));
  if (nodeRows.length > 0) unwrap(await ctx.supabase.from('exam_scope_nodes').upsert(nodeRows, { onConflict: 'exam_id,node_id' }), 'exam_scope_nodes upsert');
  unwrap(await ctx.supabase.from('exams').update({ scope_status: 'pending_review' }).eq('id', exam.id), 'exams update');
  return { status: 'matched', items: items.length };
}

export const jobs: JobDefinition[] = [
  { name: 'plan.recompute', retryLimit: 3, handler: async (ctx, data) => void (await handlePlanRecompute(ctx, data)) },
  { name: 'plan.nightly', retryLimit: 2, schedule: '30 * * * *', handler: async (ctx, data) => void (await handlePlanNightly(ctx, data)) },
  { name: 'vespera.prepare', retryLimit: 2, handler: async (ctx, data) => void (await handleVesperaPrepare(ctx, data)) },
  { name: 'scope.match', retryLimit: 2, handler: async (ctx, data) => void (await handleScopeMatch(ctx, data)) },
];


