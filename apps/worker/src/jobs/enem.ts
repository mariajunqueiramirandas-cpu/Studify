// ENEM mode jobs (spec 09, spec 08 ENM-08; api.md §7): essay.grade (+ repertorio.verify), enem.tagNodes,
// enem.topic_stats, enem.themes.predict and enem.reta_final notices. TRI, SISU, statistics and totals are code;
// the model grades, tags and writes themes.
import { z } from 'zod';
import {
  ENEM_AREA,
  REDACAO_ZERO_MAX_LINES,
  difficultyBand,
  editionsByArea,
  quartiles,
  redacaoTotal,
  retaFinalNotice,
  toStdParams,
  topicStats,
  topicTrends,
  wallClockOf,
  type EnemArea,
  type RepertorioCheck,
  type StatItem,
  type TriParamScale,
} from '@studify/shared';
import { ESSAY_ANCHORS, EnemNodeTags, EssayGrade, PredictedThemes, RepertorioVerdict, getTask } from '@studify/prompts';
import { BudgetExceededError, isCitedUrl, webSourcesOf } from '@studify/ai';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { parsePayload } from '../framework/errors.ts';
import { runPrompt, runText } from '../lib/ai-adapter.ts';
import { JobDataError, chunk, fetchAll, unwrap, unwrapRows } from '../lib/db.ts';
import { localHour, safeTimeZone } from '../lib/time.ts';

// ---------------------------------------------------------------------------
// essay.grade (ENM-05, spec 09 §7.6–7.7)
// ---------------------------------------------------------------------------

const EssayPayload = z.object({ essay_id: z.uuid(), user_id: z.uuid(), ai_job_id: z.uuid().nullable().optional() });

export const MAX_REPERTORIO_REFS = 6;
const CHARS_PER_LINE = 75;

interface EssayRow {
  id: string;
  user_id: string;
  kind: string;
  theme_id: string | null;
  prompt: { theme?: string } | null;
  text: string;
  input_mode: 'typed' | 'photo';
  status: string;
  deleted_at: string | null;
}

/** Typed essays as answer-sheet lines: paragraphs wrapped at word boundaries to 75 characters. */
export function sheetLines(text: string, inputMode: 'typed' | 'photo'): string[] {
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  if (inputMode === 'photo') return rows.filter((l) => l.trim().length > 0);
  const out: string[] = [];
  for (const paragraph of rows.map((p) => p.trim()).filter((p) => p.length > 0)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + 1 + word.length > CHARS_PER_LINE) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out;
}

type GradeOut = z.infer<typeof EssayGrade>;

/** One reference: web research with citations, then a structured verdict whose URL must be a cited one. */
export async function verifyReference(ctx: JobContext, userId: string, jobId: string | null, ref: GradeOut['repertorio_refs'][number], context: string): Promise<RepertorioCheck> {
  const base = { text: ref.text, kind: ref.kind, line: ref.line, source_url: null, source_name: null };
  try {
    const research = await runText(ctx.ai, { task: getTask('repertorio.verify'), input: { reference: { text: ref.text, kind: ref.kind }, context }, scope: { userId, jobId, feature: 'ENM-05' } });
    if (research.status !== 'ok') return { ...base, status: 'unverified', note: 'Não consegui verificar agora.' };
    const cited = webSourcesOf(research.content);
    if (cited.length === 0) return { ...base, status: 'not_found', note: 'Não encontrei fonte confiável para essa referência.' };
    const verdict = await runPrompt(ctx.ai, {
      task: getTask('repertorio.verifyStructure'),
      schema: RepertorioVerdict as unknown as z.ZodType<z.infer<typeof RepertorioVerdict>>,
      input: { reference: ref.text, researchText: research.data.slice(0, 6000), citedUrls: cited.map((c) => ({ url: c.url, title: c.title })) },
      scope: { userId, jobId, feature: 'ENM-05' },
    });
    if (verdict.result.status !== 'ok') return { ...base, status: 'unverified', note: 'Não consegui verificar agora.' };
    const v = verdict.result.data as z.infer<typeof RepertorioVerdict>;
    // A URL the research call never cited is not evidence (spec 09 §7.7): the verdict falls back to "not found".
    if (v.source_url && !isCitedUrl(v.source_url, cited)) return { ...base, status: 'not_found', note: 'Não consegui confirmar essa referência.' };
    return { ...base, status: v.status, source_url: v.source_url, source_name: v.source_name, note: v.note };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { ...base, status: 'unverified', note: 'Verificação indisponível agora.' };
    // A reference that cannot be checked stays unverified: throwing would retry the job and pay for the grade again.
    ctx.log.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'essay.grade: reference check failed');
    return { ...base, status: 'unverified', note: 'Não consegui verificar agora.' };
  }
}

export interface EssayGradeOutcome {
  status: 'graded' | 'failed' | 'skipped';
  total?: number;
}

export async function handleEssayGrade(ctx: JobContext, data: Record<string, unknown>, meta: { aiJobId: string | null }): Promise<EssayGradeOutcome> {
  const payload = parsePayload(EssayPayload, data, 'essay.grade');
  const jobId = payload.ai_job_id ?? meta.aiJobId;
  const essay = unwrap(await ctx.supabase.from('essays').select('id,user_id,kind,theme_id,prompt,text,input_mode,status,deleted_at').eq('id', payload.essay_id).maybeSingle(), 'essays') as EssayRow | null;
  if (!essay || essay.deleted_at || essay.user_id !== payload.user_id || essay.kind !== 'enem_redacao') return { status: 'skipped' };
  if (essay.status === 'graded') return { status: 'skipped' };
  const fail = async (code: string): Promise<EssayGradeOutcome> => {
    unwrap(await ctx.supabase.from('essays').update({ status: 'failed' }).eq('id', essay.id), 'essays');
    await ctx.progress({ status: 'failed', error_code: code });
    return { status: 'failed' };
  };

  let theme: { title: string; instruction: string | null; motivatingTexts: Array<{ label: string; text: string }> } = { title: essay.prompt?.theme ?? '', instruction: null, motivatingTexts: [] };
  if (essay.theme_id) {
    const row = unwrap(await ctx.supabase.from('essay_themes').select('title,prompt').eq('id', essay.theme_id).maybeSingle(), 'essay_themes') as {
      title: string;
      prompt: { instruction?: string; motivating_texts?: Array<{ label: string; text_md: string }> } | null;
    } | null;
    if (row) theme = { title: row.title, instruction: row.prompt?.instruction ?? null, motivatingTexts: (row.prompt?.motivating_texts ?? []).map((t) => ({ label: t.label, text: t.text_md })) };
  }
  if (!theme.title) return fail('no_theme');

  const lines = sheetLines(essay.text, essay.input_mode);
  await ctx.progress({ stage: 'grading', progress: 0.1 });
  let graded;
  try {
    graded = await runPrompt(ctx.ai, {
      task: getTask('essay.grade'),
      schema: EssayGrade as unknown as z.ZodType<GradeOut>,
      input: { theme, lines, inputMode: essay.input_mode, illegibleSegments: [...essay.text.matchAll(/⟦\s*ileg[ií]vel\s*⟧/gi)].map((m) => m[0]) },
      scope: { userId: essay.user_id, jobId, feature: 'ENM-05' },
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) return fail('budget_exceeded');
    throw err;
  }
  if (graded.result.status !== 'ok') return fail(graded.result.status);
  const out = graded.result.data as GradeOut;

  // Deterministic floor of ENM-05.2 still applies if the model missed it.
  const zeroReasons = [...(out.zero_check.is_zero ? out.zero_check.reasons : []), ...(lines.length <= REDACAO_ZERO_MAX_LINES ? ['texto_insuficiente'] : [])];
  const total = redacaoTotal({ competencias: out.competencias.map((c) => ({ id: c.id, score: c.score })), zeroReasons, humanRightsOk: out.proposta.direitos_humanos_ok });

  await ctx.progress({ stage: 'repertorio', progress: 0.7 });
  const refs = out.repertorio_refs.slice(0, MAX_REPERTORIO_REFS);
  const repertorio = await Promise.all(refs.map((r) => verifyReference(ctx, essay.user_id, jobId, r, r.line ? (lines[r.line - 1] ?? r.text) : r.text)));

  const competencias: Record<string, unknown> = {};
  for (const c of out.competencias) {
    competencias[`c${c.id}`] = { ...c, score: total.isZero ? c.score : total.scores[`c${c.id}`] };
  }
  unwrap(
    await ctx.supabase
      .from('essays')
      .update({
        status: 'graded',
        total: total.total,
        is_zero: total.isZero,
        zero_reasons: total.zeroReasons,
        competencias,
        proposta: out.proposta,
        repertorio,
        rewrites: out.rewrites,
        feedback: {
          top_actions: out.top_actions,
          zero_evidence: out.zero_check.evidence,
          too_long: lines.length > 30,
          calibration: ESSAY_ANCHORS.length > 0 ? 'calibrated' : 'pending',
          prompt_version: getTask('essay.grade').promptVersion,
        },
        ...(essay.input_mode === 'photo' ? { line_count: lines.length } : { est_handwritten_lines: lines.length }),
      })
      .eq('id', essay.id),
    'essays',
  );
  await ctx.progress({ status: 'done', progress: 1 });
  await ctx.enqueue('notify.dispatch', { user_id: essay.user_id, type: 'essay_graded', data: { essay_id: essay.id } }, { singletonKey: `essay_graded:${essay.id}` });
  return { status: 'graded', total: total.total };
}

// ---------------------------------------------------------------------------
// enem.tagNodes (ENM-01.4, spec 09 §7.1)
// ---------------------------------------------------------------------------

const TagPayload = z.object({ subject_id: z.uuid(), user_id: z.uuid().nullable().optional() });
export const TAG_MIN_CONFIDENCE = 0.5;

export async function handleTagNodes(ctx: JobContext, data: Record<string, unknown>): Promise<{ tagged: number; links: number } | null> {
  const payload = parsePayload(TagPayload, data, 'enem.tag_nodes');
  const subject = unwrap(await ctx.supabase.from('subjects').select('id,name,enem_area,owner_profile_id,owner_class_group_id,deleted_at').eq('id', payload.subject_id).maybeSingle(), 'subjects') as {
    id: string;
    name: string;
    enem_area: EnemArea | null;
    owner_profile_id: string | null;
    owner_class_group_id: string | null;
    deleted_at: string | null;
  } | null;
  if (!subject || subject.deleted_at || !subject.enem_area) return null;
  const nodes = unwrapRows<{ id: string; title: string; kind: 'unit' | 'topic' | 'concept'; parent_id: string | null; position: number }>(
    await ctx.supabase.from('knowledge_nodes').select('id,title,kind,parent_id,position').eq('subject_id', subject.id).is('deleted_at', null).order('position').limit(400),
    'knowledge_nodes',
  );
  if (nodes.length === 0) return { tagged: 0, links: 0 };
  const skills = unwrapRows<{ code: string; competency_no: number; description: string | null }>(
    await ctx.supabase.from('enem_skills').select('code,competency_no,description').eq('area', subject.enem_area).order('skill_no'),
    'enem_skills',
  );
  const topics = unwrapRows<{ id: string; subject: string; title: string }>(await ctx.supabase.from('enem_topics').select('id,subject,title').eq('area', subject.enem_area).order('position'), 'enem_topics');
  const keyOf = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`] as const));
  const nodeByKey = new Map<string, (typeof nodes)[number]>(nodes.map((n, i) => [`n${i + 1}`, n]));
  const topicByKey = new Map<string, (typeof topics)[number]>(topics.map((t, i) => [`T${i + 1}`, t]));
  const out = await runPrompt(ctx.ai, {
    task: getTask('enem.tagNodes'),
    schema: EnemNodeTags as unknown as z.ZodType<z.infer<typeof EnemNodeTags>>,
    input: {
      subjectName: subject.name,
      area: subject.enem_area,
      nodes: nodes.map((n) => ({ key: keyOf.get(n.id)!, title: n.title, kind: n.kind, parentKey: n.parent_id ? (keyOf.get(n.parent_id) ?? null) : null })),
      skills: skills.map((s) => ({ code: s.code, competency: s.competency_no, description: s.description })),
      topics: topics.map((t, i) => ({ key: `T${i + 1}`, path: `${subject.enem_area} › ${t.subject} › ${t.title}` })),
    },
    scope: { userId: payload.user_id ?? subject.owner_profile_id, classGroupId: subject.owner_class_group_id, subjectId: subject.id, feature: 'ENM-01' },
  });
  if (out.result.status !== 'ok') throw new JobDataError(`enem.tagNodes: ${out.result.status}`, 'ai_failed');
  const validCodes = new Set(skills.map((s) => s.code));
  let tagged = 0;
  const links: Array<{ node_id: string; enem_topic_id: string; confidence: number }> = [];
  for (const n of (out.result.data as z.infer<typeof EnemNodeTags>).nodes) {
    const node = nodeByKey.get(n.node_key);
    if (!node) continue;
    const codes = n.skill_codes.filter((c) => c.confidence >= TAG_MIN_CONFIDENCE && validCodes.has(c.code)).map((c) => c.code);
    unwrap(await ctx.supabase.from('knowledge_nodes').update({ enem_skill_codes: codes }).eq('id', node.id), 'knowledge_nodes');
    if (codes.length) tagged++;
    for (const t of n.enem_topic_keys) {
      const topic = topicByKey.get(t.key);
      if (topic && t.confidence >= TAG_MIN_CONFIDENCE) links.push({ node_id: node.id, enem_topic_id: topic.id, confidence: t.confidence });
    }
  }
  for (const part of chunk(nodes.map((n) => n.id), 150)) unwrap(await ctx.supabase.from('knowledge_node_enem_topics').delete().in('node_id', part), 'knowledge_node_enem_topics');
  for (const part of chunk(links, 200)) unwrap(await ctx.supabase.from('knowledge_node_enem_topics').insert(part), 'knowledge_node_enem_topics');
  return { tagged, links: links.length };
}

// ---------------------------------------------------------------------------
// enem.topic_stats (ENM-08.1–08.2, spec 08 §8.4) and difficulty bands (ENM-02.3)
// ---------------------------------------------------------------------------

interface BankItemRow {
  id: string;
  question_id: string;
  edition_year: number;
  area: EnemArea;
  application: 'regular' | 'ppl' | 'other';
  annulled: boolean;
  enem_topic_ids: string[] | null;
}

export async function handleTopicStats(ctx: JobContext): Promise<{ stats: number; trends: number; bands: number }> {
  const items = await fetchAll<BankItemRow>((from, to) =>
    ctx.supabase.from('enem_items').select('id,question_id,edition_year,area,application,annulled,enem_topic_ids').eq('review_status', 'ok').order('id').range(from, to),
    'enem_items',
  );
  const statItems: StatItem[] = items.map((i) => ({ id: i.id, edition_year: i.edition_year, area: i.area, application: i.application, annulled: i.annulled, enem_topic_ids: i.enem_topic_ids ?? [] }));
  const stats = topicStats(statItems);
  const topics = unwrapRows<{ id: string; area: EnemArea }>(await ctx.supabase.from('enem_topics').select('id,area'), 'enem_topics');
  const trends = topicTrends(stats, editionsByArea(statItems), new Map(topics.map((t) => [t.id, t.area] as const)));
  const now = ctx.now().toISOString();

  await ctx.db.query('delete from public.enem_topic_stats');
  for (const part of chunk(stats, 300)) unwrap(await ctx.supabase.from('enem_topic_stats').insert(part), 'enem_topic_stats');
  for (const part of chunk(
    trends.map((t) => ({ enem_topic_id: t.enem_topic_id, share_last10: t.share_last10, share_recent5: t.share_recent5, share_prev5: t.share_prev5, trend: t.trend, predicted_share: t.predicted_share, computed_at: now })),
    300,
  )) {
    unwrap(await ctx.supabase.from('enem_topic_trends').upsert(part, { onConflict: 'enem_topic_id' }), 'enem_topic_trends');
  }

  // Difficulty bands by quartiles of b per area across editions (ENM-02.3).
  const params = await fetchAll<{ enem_item_id: string; a: number; b: number; c: number; scale: TriParamScale; logistic_d: number }>((from, to) =>
    ctx.supabase.from('enem_item_params').select('enem_item_id,a,b,c,scale,logistic_d').order('enem_item_id').range(from, to),
    'enem_item_params',
  );
  const byItem = new Map(items.map((i) => [i.id, i] as const));
  let bands = 0;
  for (const area of ENEM_AREA) {
    const inArea = params
      .filter((p) => byItem.get(p.enem_item_id)?.area === area)
      .map((p) => ({ item: byItem.get(p.enem_item_id)!, b: toStdParams({ a: Number(p.a), b: Number(p.b), c: Number(p.c), scale: p.scale }).b }));
    if (inArea.length < 4) continue;
    const q = quartiles(inArea.map((x) => x.b));
    const groups = new Map<string, string[]>();
    for (const x of inArea) {
      const band = difficultyBand(x.b, q);
      groups.set(band, [...(groups.get(band) ?? []), x.item.question_id]);
    }
    for (const [band, ids] of groups) {
      for (const part of chunk(ids, 150)) unwrap(await ctx.supabase.from('questions').update({ difficulty_band: band }).in('id', part), 'questions');
      bands += ids.length;
    }
  }
  return { stats: stats.length, trends: trends.length, bands };
}

// ---------------------------------------------------------------------------
// enem.themes.predict (ENM-08.6, spec 08 §7.4) — monthly on the first Monday
// ---------------------------------------------------------------------------

/** Normalized title for the "never equal to a past theme" check (accents, case and punctuation ignored). */
export function themeKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word-level Jaccard similarity of two titles (fuzzy near-equality check). */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(themeKey(a).split(' ').filter((w) => w.length > 3));
  const wb = new Set(themeKey(b).split(' ').filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export async function handleThemesPredict(ctx: JobContext, data: Record<string, unknown>): Promise<{ status: 'skipped' | 'done'; themes?: number }> {
  const force = data.force === true;
  const today = ctx.now();
  // Cron fires every Monday; only the first Monday of the month runs (unless an admin forces it).
  if (!force && today.getUTCDate() > 7) return { status: 'skipped' };
  const past = unwrapRows<{ edition_year: number; theme: string }>(await ctx.supabase.from('enem_redacao_themes').select('edition_year,theme').order('edition_year'), 'enem_redacao_themes');
  const since = new Date(today.getTime() - 365 * 86_400_000).toISOString();
  const digests = unwrapRows<{ id: string }>(await ctx.supabase.from('atualidades_digests').select('id').eq('status', 'published').gte('published_at', since), 'atualidades_digests');
  const items = digests.length
    ? unwrapRows<{ id: string; title: string; summary_md: string; redacao_axes: string[]; sources: Array<{ url: string; name: string; published_at: string | null }> }>(
        await ctx.supabase.from('atualidades_items').select('id,title,summary_md,redacao_axes,sources').in('digest_id', digests.map((d) => d.id)).eq('withdrawn', false).limit(120),
        'atualidades_items',
      )
    : [];
  const active = unwrapRows<{ id: string; title: string }>(await ctx.supabase.from('essay_themes').select('id,title').eq('source', 'predicted').is('deleted_at', null), 'essay_themes');
  const keyed = items.map((it, i) => ({ key: `A${i + 1}`, item: it }));
  const out = await runPrompt(ctx.ai, {
    task: getTask('enem.themes.predict'),
    schema: PredictedThemes as unknown as z.ZodType<z.infer<typeof PredictedThemes>>,
    input: {
      pastThemes: past.map((p) => ({ year: p.edition_year, theme: p.theme })),
      digestItems: keyed.map((k) => ({ key: k.key, title: k.item.title, summary: k.item.summary_md.slice(0, 800), axes: k.item.redacao_axes, sources: k.item.sources.slice(0, 3) })),
      activeThemes: active.map((a) => a.title),
    },
    scope: { userId: null, feature: 'ENM-08' },
  });
  if (out.result.status !== 'ok') throw new JobDataError(`enem.themes.predict: ${out.result.status}`, 'ai_failed');
  const allowedUrls = new Set(keyed.flatMap((k) => k.item.sources.map((s) => s.url)));
  const itemByKey = new Map<string, string>(keyed.map((k) => [k.key, k.item.id]));
  const validUntil = new Date(today.getTime() + 45 * 86_400_000).toISOString().slice(0, 10);
  const rows = (out.result.data as z.infer<typeof PredictedThemes>).themes
    // Never equal or near-equal to a past ENEM theme (spec 08 §11: string + fuzzy check).
    .filter((t) => past.every((p) => themeKey(p.theme) !== themeKey(t.title) && titleSimilarity(p.theme, t.title) < 0.6))
    .map((t) => ({
      id: crypto.randomUUID(),
      title: t.title,
      axis: t.axis,
      source: 'predicted',
      rationale: t.rationale,
      connections: t.connections.map((c) => ({ atualidades_item_id: itemByKey.get(c.digest_item_key) ?? null, why: c.why })).filter((c) => c.atualidades_item_id),
      prompt: {
        instruction: t.prompt.instruction,
        motivating_texts: t.prompt.motivating_texts
          .filter((m) => allowedUrls.has(m.source_url))
          .map((m, i) => ({ label: `Texto ${['I', 'II', 'III', 'IV'][i] ?? i + 1}`, kind: m.kind, text_md: m.text, source_name: m.source_name, source_url: m.source_url, published_at: m.published_at })),
        repertorio_directions: t.repertorio_directions,
      },
      valid_until: validUntil,
      created_by: null,
    }));
  if (rows.length < 8) throw new JobDataError(`enem.themes.predict: only ${rows.length} usable themes`, 'invalid_output');
  // The new month replaces the previous predictions (kept for essays that already use them).
  if (active.length) unwrap(await ctx.supabase.from('essay_themes').update({ deleted_at: today.toISOString() }).in('id', active.map((a) => a.id)), 'essay_themes');
  unwrap(await ctx.supabase.from('essay_themes').insert(rows), 'essay_themes');
  return { status: 'done', themes: rows.length };
}

// ---------------------------------------------------------------------------
// enem.reta_final (ENM-10): Reta Final start card, eves, between days, exam days
// ---------------------------------------------------------------------------

const NOTICE_TYPE = { reta_final_start: 'reta_final_start', eve: 'enem_eve', between_days: 'enem_between_days', exam_day: 'enem_exam_day' } as const;
/** Local hour each notice goes out (exam days: the single morning message, ENM-10.6). */
const NOTICE_HOUR = { reta_final_start: 18, eve: 19, between_days: 18, exam_day: 8 } as const;

export async function handleRetaFinal(ctx: JobContext): Promise<{ sent: number }> {
  const goals = unwrapRows<{ id: string; user_id: string; settings: { enem_edition?: number; enem_date_override?: string; reta_final_weeks?: number } | null }>(
    await ctx.supabase.from('goals').select('id,user_id,settings').eq('mode', 'enem').eq('status', 'active').is('deleted_at', null),
    'goals',
  );
  if (goals.length === 0) return { sent: 0 };
  const editions = unwrapRows<{ year: number; day1_date: string | null; day2_date: string | null }>(await ctx.supabase.from('enem_editions').select('year,day1_date,day2_date'), 'enem_editions');
  const profiles = unwrapRows<{ id: string; timezone: string | null }>(await ctx.supabase.from('profiles').select('id,timezone').in('id', goals.map((g) => g.user_id)), 'profiles');
  const tzOf = new Map(profiles.map((p) => [p.id, safeTimeZone(p.timezone)] as const));
  const now = ctx.now();
  let sent = 0;
  for (const goal of goals) {
    const tz = tzOf.get(goal.user_id) ?? 'America/Sao_Paulo';
    const edition = editions.find((e) => e.year === goal.settings?.enem_edition) ?? editions.filter((e) => e.day1_date && e.day1_date >= wallClockOf(now, tz).date).sort((a, b) => a.year - b.year)[0];
    const day1 = goal.settings?.enem_date_override ?? edition?.day1_date;
    if (!day1) continue;
    const today = wallClockOf(now, tz).date;
    const notice = retaFinalNotice(today, day1, edition?.day2_date ?? null, goal.settings?.reta_final_weeks ?? 4);
    if (!notice || localHour(now, tz) !== NOTICE_HOUR[notice]) continue;
    await ctx.enqueue('notify.dispatch', { user_id: goal.user_id, type: NOTICE_TYPE[notice], data: { goal_id: goal.id } }, { singletonKey: `${NOTICE_TYPE[notice]}:${goal.id}:${today}` });
    sent++;
  }
  return { sent };
}

export const jobs: JobDefinition<any>[] = [
  { name: 'essay.grade', retryLimit: 2, expireInSeconds: 900, concurrency: 4, handler: async (ctx, data, meta) => void (await handleEssayGrade(ctx, data, meta)) },
  { name: 'enem.tag_nodes', retryLimit: 2, expireInSeconds: 900, handler: async (ctx, data) => void (await handleTagNodes(ctx, data)) },
  { name: 'enem.topic_stats', retryLimit: 1, expireInSeconds: 1800, schedule: '15 8 1 * *', handler: async (ctx) => void (await handleTopicStats(ctx)) },
  { name: 'enem.themes.predict', retryLimit: 1, expireInSeconds: 1800, schedule: '40 10 * * 1', handler: async (ctx, data) => void (await handleThemesPredict(ctx, data ?? {})) },
  { name: 'enem.reta_final', retryLimit: 1, expireInSeconds: 600, schedule: '5 * * * *', handler: async (ctx) => void (await handleRetaFinal(ctx)) },
];
