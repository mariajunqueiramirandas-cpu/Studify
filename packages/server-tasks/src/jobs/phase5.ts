// Phase 5 jobs:
//  - ingest.material_check (ING-06): after S2 the document is reviewed for possible errors, slice by slice; at most
//    20 findings per document, never applied to the content (ING-06.4).
//  - divide.merge (SOC-06.4–06.5): the approved summaries of each topic become one Resumo da turma (a class_summary
//    note with citations and contributor credits; corrections listed at the end by the model).
//  - league.weekly (SOC-08.2/.4): closes last week's league of every Turma with ranks and badges.
//  - retro.generate (MOT-04): daily; builds the Retrospectivas that are due (goal recap, semester, year).
//  - energy.windows (GOL-10.1): nightly; performance residual per 2-hour window from reviews and answers.
import { getTask, MaterialFindings, RetroTitle, type MaterialFindingsOutput, type MaterialCheckInput } from '@studify/prompts';
import {
  DEFAULT_SEMESTER_ENDS,
  leagueBadges,
  leagueWeekXp,
  performanceResidual,
  performanceWindows,
  predictSuccess,
  rankFindings,
  rankLeague,
  retroFallbackTitle,
  retroPeriodsDue,
  wallClockOf,
  type RetroPeriod,
  type RetroStats,
} from '@studify/shared';
import type { OperationContext, OperationDefinition } from '../framework/types.ts';
import { runPrompt, runText } from '../lib/ai-adapter.ts';
import { IN_CHUNK, chunk, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { addDays, localDateOf, safeTimeZone } from '../lib/time.ts';
import { createEnv } from '../ingest/env.ts';
import { supabaseStore } from '../ingest/store.ts';
import { topicSliceRefs } from '../ingest/topics.ts';
import { toPdfSlices } from '../ingest/tasks.ts';
import { renderCitedBody, type CitationInput } from '../ingest/citations.ts';

// ---------------------------------------------------------------------------
// ING-06 material checker
// ---------------------------------------------------------------------------

/** One call per slice of this many pages; documents above MAX_CHECK_PAGES are checked up to that page. */
export const CHECK_SLICE_PAGES = 60;
export const MAX_CHECK_PAGES = 600;

export interface FindingRow {
  document_id: string;
  subject_id: string;
  node_id: string | null;
  related_document_id: string | null;
  type: MaterialFindingsOutput['findings'][number]['type'];
  severity: 'low' | 'medium' | 'high';
  page_start: number;
  page_end: number;
  related_page: number | null;
  description: string;
  suggested_fix: string | null;
}

/**
 * Maps the model's findings to rows: doc labels to document ids, node keys to topics (or the topic whose pages
 * contain the finding), related O-keys to the other document. Findings on documents the call did not see are
 * dropped (the page check already refused pages outside the slice).
 */
export function findingRows(
  out: MaterialFindingsOutput,
  ctx: {
    documentId: string;
    subjectId: string;
    labels: Record<string, string>;
    topicByKey: ReadonlyMap<string, string>;
    topicRanges: ReadonlyArray<{ nodeId: string; start: number; end: number }>;
    otherByKey: ReadonlyMap<string, string>;
  },
): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const f of out.findings) {
    if (ctx.labels[f.doc] !== ctx.documentId) continue;
    const nodeId = (f.node_key ? ctx.topicByKey.get(f.node_key) : undefined) ?? ctx.topicRanges.find((r) => f.page_start >= r.start && f.page_start <= r.end)?.nodeId ?? null;
    let relatedDocument: string | null = null;
    let relatedPage: number | null = null;
    if (f.related) {
      relatedPage = f.related.page;
      if (f.related.doc.startsWith('O')) relatedDocument = ctx.otherByKey.get(f.related.doc) ?? null;
    }
    rows.push({
      document_id: ctx.documentId,
      subject_id: ctx.subjectId,
      node_id: nodeId,
      related_document_id: relatedDocument,
      type: f.type,
      severity: f.severity,
      page_start: f.page_start,
      page_end: f.page_end,
      related_page: relatedPage,
      description: f.description,
      suggested_fix: f.suggested_fix,
    });
  }
  return rows;
}

export async function handleMaterialCheck(ctx: OperationContext, data: { document_id: string; force?: boolean }): Promise<{ status: 'done' | 'skipped'; findings?: number }> {
  const sb = ctx.supabase;
  const doc = unwrap(await sb.from('documents').select('id, subject_id, uploaded_by, title, page_count, status, deleted_at, language').eq('id', data.document_id).maybeSingle(), 'documents') as {
    id: string;
    subject_id: string;
    uploaded_by: string | null;
    title: string;
    page_count: number | null;
    deleted_at: string | null;
    language: string | null;
  } | null;
  if (!doc || doc.deleted_at || !doc.page_count) return { status: 'skipped' };
  const existing = unwrapRows(await sb.from('material_findings').select('id').eq('document_id', doc.id).limit(1), 'material_findings');
  if (existing.length && !data.force) return { status: 'skipped' };

  const subject = unwrap(await sb.from('subjects').select('id, owner_class_group_id, content_language, created_by').eq('id', doc.subject_id).maybeSingle(), 'subjects') as {
    id: string;
    owner_class_group_id: string | null;
    content_language: string | null;
    created_by: string;
  } | null;
  if (!subject) return { status: 'skipped' };

  // Topics of this document and their page ranges.
  const sources = unwrapRows<{ node_id: string; page_start: number; page_end: number }>(
    await sb.from('node_sources').select('node_id, page_start, page_end').eq('document_id', doc.id).is('deleted_at', null),
    'node_sources',
  );
  const nodeIds = uniq(sources.map((s) => s.node_id));
  const nodes = nodeIds.length
    ? unwrapRows<{ id: string; title: string; kind: string }>(await sb.from('knowledge_nodes').select('id, title, kind').in('id', nodeIds.slice(0, IN_CHUNK)).is('deleted_at', null), 'knowledge_nodes')
    : [];
  const topics = nodes.filter((n) => n.kind === 'topic');
  const topicByKey = new Map(topics.map((t, i) => [`t${i + 1}`, t.id]));
  const topicRanges = sources.filter((s) => topics.some((t) => t.id === s.node_id)).map((s) => ({ nodeId: s.node_id, start: s.page_start, end: s.page_end }));

  // Merges: the other documents of the subject, as topic summaries.
  const others = unwrapRows<{ id: string; title: string }>(
    await sb.from('documents').select('id, title').eq('subject_id', doc.subject_id).neq('id', doc.id).eq('status', 'ready').is('deleted_at', null).limit(5),
    'documents',
  );
  const otherByKey = new Map(others.map((o, i) => [`O${i + 1}`, o.id]));
  const otherDocuments: MaterialCheckInput['otherDocuments'][number][] = [];
  for (const [key, id] of otherByKey) {
    const srcs = unwrapRows<{ node_id: string }>(await sb.from('node_sources').select('node_id').eq('document_id', id).is('deleted_at', null).limit(60), 'node_sources');
    const ns = srcs.length
      ? unwrapRows<{ title: string; summary: string | null; kind: string }>(await sb.from('knowledge_nodes').select('title, summary, kind').in('id', uniq(srcs.map((s) => s.node_id))).is('deleted_at', null), 'knowledge_nodes')
      : [];
    otherDocuments.push({ key, title: others.find((o) => o.id === id)!.title, topics: ns.filter((n) => n.kind === 'topic').slice(0, 15).map((n) => ({ title: n.title, summary: n.summary ?? '' })) });
  }

  const env = createEnv(ctx, supabaseStore(sb));
  const lastPage = Math.min(doc.page_count, MAX_CHECK_PAGES);
  const rows: FindingRow[] = [];
  for (let start = 1; start <= lastPage; start += CHECK_SLICE_PAGES) {
    const refs = await topicSliceRefs(env, [{ documentId: doc.id, pageStart: start, pageEnd: Math.min(lastPage, start + CHECK_SLICE_PAGES - 1) }], { context: false });
    // No student waits on the check: background in the shared lane, after every material's own content.
    const check = () => runPrompt(ctx.ai, {
      task: getTask('material.check'),
      schema: MaterialFindings,
      input: {
        documentTitle: doc.title,
        slices: toPdfSlices(refs),
        topics: [...topicByKey].map(([key, id]) => ({ key, title: topics.find((t) => t.id === id)!.title })),
        otherDocuments,
        contentLanguage: subject.content_language ?? doc.language ?? 'pt-BR',
      },
      // Content calls are charged to a student (the budget refuses them without one): the uploader.
      scope: { userId: doc.uploaded_by ?? subject.created_by, classGroupId: subject.owner_class_group_id, subjectId: subject.id, documentId: doc.id, feature: 'ING-06' },
    });
    const { result, documents } = ctx.aiLane ? await ctx.aiLane({ position: 0, background: true }, check) : await check();
    if (result.status !== 'ok') {
      ctx.log.warn({ status: result.status, start }, 'material.check slice skipped');
      continue;
    }
    rows.push(...findingRows(result.data, { documentId: doc.id, subjectId: subject.id, labels: documents?.labels ?? {}, topicByKey, topicRanges, otherByKey }));
  }
  const ranked = rankFindings(rows);
  if (data.force) unwrap(await sb.from('material_findings').delete().eq('document_id', doc.id).eq('status', 'open'), 'material_findings');
  if (ranked.length) unwrap(await sb.from('material_findings').insert(ranked.map((r) => ({ ...r, prompt_version: getTask('material.check').promptVersion }))), 'material_findings');
  return { status: 'done', findings: ranked.length };
}

// ---------------------------------------------------------------------------
// SOC-06 divide.merge
// ---------------------------------------------------------------------------

export async function handleDivideMerge(ctx: OperationContext, data: { divide_plan_id: string }): Promise<{ status: 'done' | 'skipped'; notes?: number }> {
  const sb = ctx.supabase;
  const plan = unwrap(await sb.from('divide_plans').select('id, class_group_id, subject_id, status, created_by, title').eq('id', data.divide_plan_id).maybeSingle(), 'divide_plans') as {
    id: string;
    class_group_id: string;
    subject_id: string;
    status: string;
    created_by: string;
    title: string;
  } | null;
  if (!plan || plan.status !== 'merging') return { status: 'skipped' };
  const subject = unwrap(await sb.from('subjects').select('id, content_language').eq('id', plan.subject_id).maybeSingle(), 'subjects') as { id: string; content_language: string | null } | null;
  const contributions = unwrapRows<{ node_id: string; author_id: string; body_md: string }>(
    await sb.from('contributions').select('node_id, author_id, body_md').eq('divide_plan_id', plan.id).eq('status', 'approved'),
    'contributions',
  );
  const byNode = new Map<string, Array<{ author: string; body: string }>>();
  for (const c of contributions) byNode.set(c.node_id, [...(byNode.get(c.node_id) ?? []), { author: c.author_id, body: c.body_md }]);

  const env = createEnv(ctx, supabaseStore(sb));
  const task = getTask('divide.merge');
  let written = 0;
  for (const [nodeId, parts] of byNode) {
    const node = unwrap(await sb.from('knowledge_nodes').select('id, title, summary').eq('id', nodeId).is('deleted_at', null).maybeSingle(), 'knowledge_nodes') as { id: string; title: string; summary: string | null } | null;
    if (!node) continue;
    const spans = unwrapRows<{ document_id: string; page_start: number; page_end: number }>(
      await sb.from('node_sources').select('document_id, page_start, page_end').eq('node_id', nodeId).is('deleted_at', null),
      'node_sources',
    ).map((s) => ({ documentId: s.document_id, pageStart: s.page_start, pageEnd: s.page_end }));
    if (spans.length === 0) continue;
    const refs = await topicSliceRefs(env, spans);
    const result = await runText(ctx.ai, {
      task,
      input: { topic: { title: node.title, summary: node.summary ?? '' }, contributions: parts.map((p) => p.body), slices: toPdfSlices(refs), contentLanguage: subject?.content_language ?? 'pt-BR' },
      scope: { userId: null, classGroupId: plan.class_group_id, subjectId: plan.subject_id, nodeId, feature: 'SOC-06' },
    });
    if (result.status !== 'ok') {
      ctx.log.warn({ status: result.status, nodeId }, 'divide.merge topic skipped');
      continue;
    }
    const inputs: CitationInput[] = result.citations.map((c) => ({ textStart: c.textStart, textEnd: c.textEnd, documentId: c.documentId, pageStart: c.pageStart, pageEnd: c.pageEnd, citedText: c.citedText, valid: c.valid }));
    const rendered = renderCitedBody(result.data, inputs);
    const body = rendered.body.trim();
    unwrap(
      await sb.from('notes').update({ status: 'superseded' }).eq('node_id', nodeId).eq('depth', 'class_summary').in('status', ['pending', 'generating', 'ready']).is('deleted_at', null),
      'notes',
    );
    unwrap(
      await sb.from('notes').insert({
        subject_id: plan.subject_id,
        node_id: nodeId,
        scope_kind: 'topic',
        depth: 'class_summary',
        body,
        citations: rendered.citations,
        language: subject?.content_language ?? 'pt-BR',
        word_count: body.split(/\s+/).filter(Boolean).length,
        has_math: body.includes('$'),
        status: 'ready',
        low_citation_coverage: rendered.citations.length === 0,
        contributors: uniq(parts.map((p) => p.author)),
        created_by: plan.created_by,
        prompt_version: task.promptVersion,
      }),
      'notes',
    );
    written++;
  }
  unwrap(await sb.from('divide_plans').update({ status: 'done' }).eq('id', plan.id).eq('status', 'merging'), 'divide_plans');
  const members = unwrapRows<{ user_id: string }>(await sb.from('class_group_members').select('user_id').eq('class_group_id', plan.class_group_id).eq('status', 'active'), 'class_group_members');
  for (const m of members) {
    await ctx.execute('notify.dispatch', { user_id: m.user_id, type: 'divide_merged', data: { class_group_id: plan.class_group_id, divide_plan_id: plan.id } }, { singletonKey: `divide_merged:${plan.id}:${m.user_id}` });
  }
  return { status: 'done', notes: written };
}

// ---------------------------------------------------------------------------
// SOC-08 league.weekly
// ---------------------------------------------------------------------------

/** Monday of the previous week (Brasília calendar), the week the job closes. */
export function closedWeekStart(now: Date): string {
  const today = wallClockOf(now, 'America/Sao_Paulo').date;
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, -weekday - 7);
}

export async function handleLeagueWeekly(ctx: OperationContext, data: { week_start?: string }): Promise<{ groups: number; entries: number }> {
  const sb = ctx.supabase;
  const week = data.week_start ?? closedWeekStart(ctx.now());
  const weekEnd = addDays(week, 6);
  const members = unwrapRows<{ class_group_id: string; user_id: string }>(
    await sb.from('class_group_members').select('class_group_id, user_id').eq('status', 'active').eq('league_opt_in', true),
    'class_group_members',
  );
  const byGroup = new Map<string, string[]>();
  for (const m of members) byGroup.set(m.class_group_id, [...(byGroup.get(m.class_group_id) ?? []), m.user_id]);
  let entries = 0;
  for (const [groupId, userIds] of byGroup) {
    const rows: Array<{ userId: string; xp: number; reachedAt: string | null; goalDays: number }> = [];
    for (const part of chunk(userIds, IN_CHUNK)) {
      const events = unwrapRows<{ user_id: string; local_date: string; amount: number; in_quiet_hours: boolean; occurred_at: string }>(
        await sb.from('xp_events').select('user_id, local_date, amount, in_quiet_hours, occurred_at').in('user_id', part).gte('local_date', week).lte('local_date', weekEnd),
        'xp_events',
      );
      const goals = unwrapRows<{ user_id: string }>(
        await sb.from('daily_activity').select('user_id').in('user_id', part).eq('goal_met', true).gte('local_date', week).lte('local_date', weekEnd),
        'daily_activity',
      );
      for (const userId of part) {
        const mine = events.filter((e) => e.user_id === userId).map((e) => ({ localDate: e.local_date, amount: e.amount, inQuietHours: e.in_quiet_hours, occurredAt: e.occurred_at }));
        rows.push({ userId, ...leagueWeekXp(mine), goalDays: goals.filter((g) => g.user_id === userId).length });
      }
    }
    const ranked = rankLeague(rows);
    const upserts = ranked.map((r) => ({
      class_group_id: groupId,
      user_id: r.userId,
      week_start: week,
      league_xp: r.xp,
      rank: r.rank,
      badges: leagueBadges(r.rank, r.xp, rows.find((x) => x.userId === r.userId)!.goalDays),
      reached_at: r.reachedAt,
    }));
    if (upserts.length) unwrap(await sb.from('league_entries').upsert(upserts, { onConflict: 'class_group_id,user_id,week_start' }), 'league_entries');
    entries += upserts.length;
  }
  return { groups: byGroup.size, entries };
}

// ---------------------------------------------------------------------------
// MOT-04 retro.generate
// ---------------------------------------------------------------------------

/** Days back that make a user a candidate for a semester or year Retrospectiva. */
export const RETRO_ACTIVE_DAYS = 190;
const RETRO_MIN_ANSWERS_SUBJECT = 20;
const RETRO_MIN_ANSWERS_HALF = 5;

function longestRun(days: readonly string[]): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export async function retroStats(ctx: OperationContext, userId: string, period: RetroPeriod): Promise<RetroStats> {
  const sb = ctx.supabase;
  const activity = unwrapRows<{ local_date: string; active_minutes: number; reviews: number; questions: number; counted: boolean }>(
    await sb.from('daily_activity').select('local_date, active_minutes, reviews, questions, counted').eq('user_id', userId).gte('local_date', period.start).lte('local_date', period.end),
    'daily_activity',
  );
  const startIso = `${period.start}T00:00:00Z`;
  const endIso = `${addDays(period.end, 1)}T06:00:00Z`;
  const answers = unwrapRows<{ question_id: string; correct: boolean | null; answered_at: string }>(
    await sb.from('attempt_answers').select('question_id, correct, answered_at').eq('user_id', userId).gte('answered_at', startIso).lt('answered_at', endIso).is('deleted_at', null).limit(5000),
    'attempt_answers',
  ).filter((a) => a.correct !== null);
  const qInfo = new Map<string, { subject_id: string; node_id: string | null }>();
  for (const part of chunk(uniq(answers.map((a) => a.question_id)), IN_CHUNK)) {
    for (const q of unwrapRows<{ id: string; subject_id: string; node_id: string | null }>(await sb.from('questions').select('id, subject_id, node_id').in('id', part), 'questions')) qInfo.set(q.id, q);
  }
  const bySubject = new Map<string, { n: number; c: number }>();
  const mid = Date.parse(startIso) + (Date.parse(endIso) - Date.parse(startIso)) / 2;
  const byNode = new Map<string, { a: { n: number; c: number }; b: { n: number; c: number } }>();
  for (const a of answers) {
    const info = qInfo.get(a.question_id);
    if (!info) continue;
    const s = bySubject.get(info.subject_id) ?? { n: 0, c: 0 };
    s.n++;
    if (a.correct) s.c++;
    bySubject.set(info.subject_id, s);
    if (info.node_id) {
      const t = byNode.get(info.node_id) ?? { a: { n: 0, c: 0 }, b: { n: 0, c: 0 } };
      const half = Date.parse(a.answered_at) < mid ? t.a : t.b;
      half.n++;
      if (a.correct) half.c++;
      byNode.set(info.node_id, t);
    }
  }
  const bestSubject = [...bySubject].filter(([, v]) => v.n >= RETRO_MIN_ANSWERS_SUBJECT).sort((x, y) => y[1].c / y[1].n - x[1].c / x[1].n)[0];
  let bestSubjectRow: RetroStats['best_subject'] = null;
  if (bestSubject) {
    const name = (unwrap(await sb.from('subjects').select('name').eq('id', bestSubject[0]).maybeSingle(), 'subjects') as { name: string } | null)?.name;
    if (name) bestSubjectRow = { name, accuracy: Math.round((bestSubject[1].c / bestSubject[1].n) * 100) / 100 };
  }
  const improved = [...byNode]
    .filter(([, v]) => v.a.n >= RETRO_MIN_ANSWERS_HALF && v.b.n >= RETRO_MIN_ANSWERS_HALF)
    .map(([id, v]) => ({ id, from: v.a.c / v.a.n, to: v.b.c / v.b.n }))
    .filter((x) => x.to > x.from)
    .sort((x, y) => y.to - y.from - (x.to - x.from))[0];
  let improvedRow: RetroStats['most_improved_topic'] = null;
  if (improved) {
    const title = (unwrap(await sb.from('knowledge_nodes').select('title').eq('id', improved.id).maybeSingle(), 'knowledge_nodes') as { title: string } | null)?.title;
    if (title) improvedRow = { title, from: Math.round(improved.from * 100) / 100, to: Math.round(improved.to * 100) / 100 };
  }
  const lucas = unwrapRows<{ score: number | null }>(
    await sb.from('teaching_sessions').select('score').eq('user_id', userId).gte('created_at', startIso).lt('created_at', endIso).not('score', 'is', null).order('score', { ascending: false }).limit(1),
    'teaching_sessions',
  );
  const duels = unwrapRows(await sb.from('duels').select('id').eq('winner_id', userId).eq('status', 'finished').gte('updated_at', startIso).lt('updated_at', endIso).limit(500), 'duels');
  const exams = unwrapRows<{ subject_id: string | null; grade: number | null; grade_max: number | null }>(
    await sb.from('exams').select('subject_id, grade, grade_max').eq('user_id', userId).gte('local_date', period.start).lte('local_date', period.end).not('grade', 'is', null).is('deleted_at', null).limit(30),
    'exams',
  );
  const grades: RetroStats['grades'] = [];
  for (const e of exams) {
    const name = e.subject_id ? (unwrap(await sb.from('subjects').select('name').eq('id', e.subject_id).maybeSingle(), 'subjects') as { name: string } | null)?.name : null;
    grades.push({ subject: name ?? 'Prova', grade: `${String(e.grade).replace('.', ',')}${e.grade_max ? `/${String(e.grade_max).replace('.', ',')}` : ''}` });
  }
  const graded = answers.length;
  return {
    period: period.type,
    active_minutes: activity.reduce((s, a) => s + (a.active_minutes ?? 0), 0),
    days_studied: activity.filter((a) => a.counted).length,
    cards_reviewed: activity.reduce((s, a) => s + (a.reviews ?? 0), 0),
    questions_answered: activity.reduce((s, a) => s + (a.questions ?? 0), 0),
    accuracy: graded ? Math.round((answers.filter((a) => a.correct).length / graded) * 100) / 100 : null,
    best_subject: bestSubjectRow,
    most_improved_topic: improvedRow,
    longest_streak: longestRun(activity.filter((a) => a.counted).map((a) => a.local_date)),
    best_lucas_score: lucas[0]?.score ?? null,
    duels_won: duels.length,
    calibration_gain: null,
    grades,
  };
}

/** Numbers only for the title prompt: never names or grades (spec 13 §7). */
export function retroTitleStats(stats: RetroStats): Record<string, number | null> {
  return {
    active_hours: Math.round(stats.active_minutes / 60),
    days_studied: stats.days_studied,
    cards_reviewed: stats.cards_reviewed,
    questions_answered: stats.questions_answered,
    accuracy_pct: stats.accuracy === null ? null : Math.round(stats.accuracy * 100),
    longest_streak: stats.longest_streak,
  };
}

async function createRetro(ctx: OperationContext, userId: string, period: RetroPeriod): Promise<boolean> {
  const sb = ctx.supabase;
  let q = sb.from('retrospectives').select('id').eq('user_id', userId).eq('period_type', period.type).eq('period_start', period.start).eq('period_end', period.end);
  q = period.goalId ? q.eq('goal_id', period.goalId) : q.is('goal_id', null);
  if (unwrapRows(await q.limit(1), 'retrospectives').length) return false;
  const stats = await retroStats(ctx, userId, period);
  if (stats.active_minutes === 0 && stats.cards_reviewed === 0 && stats.questions_answered === 0) return false;
  let { title, subtitle } = retroFallbackTitle(period.type);
  const { result } = await runPrompt(ctx.ai, { task: getTask('retro.title'), schema: RetroTitle, input: { period: period.type, stats: retroTitleStats(stats) }, scope: { userId, feature: 'MOT-04' } });
  if (result.status === 'ok') {
    title = result.data.title_pt;
    subtitle = result.data.subtitle_pt;
  }
  unwrap(
    await sb.from('retrospectives').insert({ user_id: userId, period_type: period.type, goal_id: period.goalId, period_start: period.start, period_end: period.end, stats, title, subtitle }),
    'retrospectives',
  );
  await ctx.execute('notify.dispatch', { user_id: userId, type: 'retro_ready', data: {} }, { singletonKey: `retro_ready:${userId}:${period.type}:${period.end}` });
  return true;
}

export async function handleRetroGenerate(ctx: OperationContext): Promise<{ created: number }> {
  const sb = ctx.supabase;
  const spToday = localDateOf(ctx.now(), 'America/Sao_Paulo');
  const since = addDays(spToday, -RETRO_ACTIVE_DAYS);
  const active = uniq(
    unwrapRows<{ user_id: string }>(await sb.from('daily_activity').select('user_id').gte('local_date', since).eq('counted', true).limit(50_000), 'daily_activity').map((r) => r.user_id),
  );
  let created = 0;
  for (const part of chunk(active, IN_CHUNK)) {
    const profiles = unwrapRows<{ id: string; timezone: string | null; settings: { semester_ends?: string[] } | null }>(
      await sb.from('profiles').select('id, timezone, settings').in('id', part),
      'profiles',
    );
    const goals = unwrapRows<{ id: string; user_id: string; start_date: string }>(
      await sb.from('goals').select('id, user_id, start_date').in('user_id', part).eq('mode', 'exam_week').is('deleted_at', null),
      'goals',
    );
    const exams = goals.length
      ? unwrapRows<{ goal_id: string; local_date: string }>(await sb.from('exams').select('goal_id, local_date').in('goal_id', goals.map((g) => g.id).slice(0, IN_CHUNK)).is('deleted_at', null), 'exams')
      : [];
    for (const p of profiles) {
      const today = localDateOf(ctx.now(), safeTimeZone(p.timezone));
      const mine = goals
        .filter((g) => g.user_id === p.id)
        .map((g) => {
          const dates = exams.filter((e) => e.goal_id === g.id).map((e) => e.local_date).sort();
          return { id: g.id, startDate: g.start_date, lastExamDay: dates.at(-1) ?? null };
        });
      const ends = Array.isArray(p.settings?.semester_ends) && p.settings.semester_ends.length ? p.settings.semester_ends : [...DEFAULT_SEMESTER_ENDS];
      for (const period of retroPeriodsDue(today, mine, ends)) {
        try {
          if (await createRetro(ctx, p.id, period)) created++;
        } catch (err) {
          ctx.log.warn({ userId: p.id, period: period.type, err: err instanceof Error ? err.message : String(err) }, 'retrospective skipped');
        }
      }
    }
  }
  return { created };
}

// ---------------------------------------------------------------------------
// GOL-10 energy.windows
// ---------------------------------------------------------------------------

/** History the windows are computed from. */
export const ENERGY_LOOKBACK_DAYS = 60;

export async function handleEnergyWindows(ctx: OperationContext, data: { user_ids?: string[] }): Promise<{ users: number }> {
  const sb = ctx.supabase;
  const sinceIso = new Date(ctx.now().getTime() - ENERGY_LOOKBACK_DAYS * 86_400_000).toISOString();
  const userIds =
    data.user_ids ??
    uniq(unwrapRows<{ user_id: string }>(await sb.from('daily_activity').select('user_id').gte('local_date', sinceIso.slice(0, 10)).eq('counted', true).limit(50_000), 'daily_activity').map((r) => r.user_id));
  let users = 0;
  for (const userId of userIds) {
    const profile = unwrap(await sb.from('profiles').select('timezone').eq('id', userId).maybeSingle(), 'profiles') as { timezone: string | null } | null;
    const tz = safeTimeZone(profile?.timezone);
    const reviews = unwrapRows<{ rating: number; reviewed_at: string; state_before: number | null }>(
      await sb.from('review_logs').select('rating, reviewed_at, state_before').eq('user_id', userId).gte('reviewed_at', sinceIso).limit(20_000),
      'review_logs',
    );
    const answers = unwrapRows<{ question_id: string; correct: boolean | null; answered_at: string }>(
      await sb.from('attempt_answers').select('question_id, correct, answered_at').eq('user_id', userId).gte('answered_at', sinceIso).is('deleted_at', null).limit(10_000),
      'attempt_answers',
    ).filter((a) => a.correct !== null);
    if (reviews.length + answers.length < 50) continue;
    // Expected recall for cards: the student's own pass rate for the card state (a stored per-review R is not
    // kept); for questions: p̂ from the question difficulty (learning-engine §6.1).
    const passBy = new Map<number, { n: number; pass: number }>();
    for (const r of reviews) {
      const k = r.state_before ?? 2;
      const v = passBy.get(k) ?? { n: 0, pass: 0 };
      v.n++;
      if (r.rating > 1) v.pass++;
      passBy.set(k, v);
    }
    const difficulty = new Map<string, number>();
    for (const part of chunk(uniq(answers.map((a) => a.question_id)), IN_CHUNK)) {
      for (const q of unwrapRows<{ id: string; difficulty: number | null }>(await sb.from('questions').select('id, difficulty').in('id', part), 'questions')) difficulty.set(q.id, q.difficulty ?? 3);
    }
    const events = [
      ...reviews.map((r) => {
        const w = wallClockOf(new Date(r.reviewed_at), tz);
        const base = passBy.get(r.state_before ?? 2)!;
        return { localDate: w.date, minuteOfDay: w.hour * 60 + w.minute, residual: performanceResidual(r.rating > 1, base.pass / base.n) };
      }),
      ...answers.map((a) => {
        const w = wallClockOf(new Date(a.answered_at), tz);
        return { localDate: w.date, minuteOfDay: w.hour * 60 + w.minute, residual: performanceResidual(a.correct === true, predictSuccess({ difficulty: difficulty.get(a.question_id) ?? 3, conceptMasteries: [null] })) };
      }),
    ];
    const windows = performanceWindows(events);
    const rows = windows.windows.map((w) => ({
      user_id: userId,
      bucket: w.bucket,
      n_events: w.n,
      mean_residual: Math.round(w.mean * 1000) / 1000,
      ci_low: w.ciLow === null ? null : Math.round(w.ciLow * 1000) / 1000,
      ci_high: w.ciHigh === null ? null : Math.round(w.ciHigh * 1000) / 1000,
      good: windows.best.includes(w.bucket),
      updated_at: ctx.now().toISOString(),
    }));
    unwrap(await sb.from('performance_windows').delete().eq('user_id', userId), 'performance_windows');
    if (rows.length) unwrap(await sb.from('performance_windows').insert(rows), 'performance_windows');
    users++;
  }
  return { users };
}

export const jobs: OperationDefinition<any>[] = [
  // A side job of the material: it has no progress of its own to show next to the material's.
  { name: 'ingest.material_check', tracksProgress: false, handler: async (ctx, data) => void (await handleMaterialCheck(ctx, data)) },
  { name: 'divide.merge', handler: async (ctx, data) => void (await handleDivideMerge(ctx, data)) },
  // Monday 00:10 Brasília (03:10 UTC): closes the week that just ended.
  { name: 'league.weekly', schedule: '10 3 * * 1', handler: async (ctx, data) => void (await handleLeagueWeekly(ctx, data ?? {})) },
  // Daily 05:20 Brasília (08:20 UTC), after the streak rollover.
  { name: 'retro.generate', schedule: '20 8 * * *', handler: async (ctx) => void (await handleRetroGenerate(ctx)) },
  // Daily 04:40 Brasília (07:40 UTC).
  { name: 'energy.windows', schedule: '40 7 * * *', handler: async (ctx, data) => void (await handleEnergyWindows(ctx, data ?? {})) },
];
