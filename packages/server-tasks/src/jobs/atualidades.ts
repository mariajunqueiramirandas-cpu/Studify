// Atualidades (ENM-09, spec 09 §7.8): atualidades.weekly researches the past 7 days on the admin allowlist with the
// web_search tool, then structures a draft digest whose every source and repertório URL must be a citation of the
// research call and an allowlisted domain. Each item gets 2 ENEM-style practice questions in the Atualidades system
// subject. An admin publishes the draft (admin-atualidades-publish), which triggers atualidades.notify (opt-in push).
import { z } from 'zod';
import { AtualidadesDigest, getTask } from '@studify/prompts';
import { isAllowedDomain, isCitedUrl, webSourcesOf } from '@studify/ai';
import { parseQuestionPayload, wallClockOf } from '@studify/shared';
import type { OperationContext, OperationDefinition } from '../framework/types.ts';
import { runPrompt, runText } from '../lib/ai-adapter.ts';
import { JobDataError, unwrap, unwrapRows } from '../lib/db.ts';
import { addDays } from '../lib/time.ts';

type Digest = z.infer<typeof AtualidadesDigest>;
export const ATUALIDADES_MIN_ITEMS = 3;

/** Monday (Brasília) of the week that contains `now`. */
export function weekStartOf(now: Date): string {
  const today = wallClockOf(now, 'America/Sao_Paulo').date;
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, -weekday);
}

/**
 * Keeps only what the research call cited from allowlisted domains: sources and repertório URLs are filtered,
 * and an item left without a source is dropped (spec 09 §11). Skill codes outside the Matriz are removed.
 */
export function validateDigest(digest: Digest, cited: ReadonlyArray<{ url: string }>, allowed: readonly string[], skillCodes: ReadonlySet<string>): Digest['items'] {
  const ok = (url: string) => isCitedUrl(url, cited) && isAllowedDomain(url, allowed);
  return digest.items
    .map((item) => ({
      ...item,
      sources: item.sources.filter((s) => ok(s.url)),
      repertorio: item.repertorio.filter((r) => ok(r.source_url)),
      skill_codes: item.skill_codes.filter((c) => skillCodes.has(c)),
    }))
    .filter((item) => item.sources.length > 0);
}

async function ensureAtualidadesSubject(ctx: OperationContext): Promise<{ subjectId: string; nodeId: string }> {
  let subject = unwrap(await ctx.db.from('subjects').select('id').eq('system_kind', 'atualidades').is('deleted_at', null).maybeSingle(), 'subjects') as { id: string } | null;
  if (!subject) {
    const admin = unwrap(await ctx.db.from('profiles').select('id').eq('app_role', 'app_admin').limit(1).maybeSingle(), 'profiles') as { id: string } | null;
    if (!admin) throw new JobDataError('atualidades: no app_admin profile to own the system subject', 'config');
    const id = crypto.randomUUID();
    unwrap(await ctx.db.from('subjects').insert({ id, owner_profile_id: admin.id, created_by: admin.id, name: 'Atualidades', color: '#c2410c', icon: 'newspaper', system_kind: 'atualidades', content_language: 'pt-BR' }), 'subjects');
    subject = { id };
  }
  let node = unwrap(await ctx.db.from('knowledge_nodes').select('id').eq('subject_id', subject.id).eq('kind', 'unit').is('deleted_at', null).limit(1).maybeSingle(), 'knowledge_nodes') as { id: string } | null;
  if (!node) {
    const id = crypto.randomUUID();
    unwrap(await ctx.db.from('knowledge_nodes').insert({ id, subject_id: subject.id, parent_id: null, kind: 'unit', title: 'Atualidades', content_status: 'skipped_excluded' }), 'knowledge_nodes');
    node = { id };
  }
  return { subjectId: subject.id, nodeId: node.id };
}

export interface WeeklyOutcome {
  status: 'drafted' | 'exists' | 'skipped';
  digestId?: string;
  items?: number;
  reason?: string;
}

export async function handleAtualidadesWeekly(ctx: OperationContext, data: Record<string, unknown>): Promise<WeeklyOutcome> {
  const weekStart = typeof data.week_start === 'string' ? data.week_start : weekStartOf(ctx.now());
  const existing = unwrap(await ctx.db.from('atualidades_digests').select('id').eq('week_start', weekStart).maybeSingle(), 'atualidades_digests');
  if (existing) return { status: 'exists' };
  const allowed = (await ctx.sql.query<{ domain: string }>('select domain from private.atualidades_sources where enabled order by domain')).rows.map((r) => r.domain);
  if (allowed.length === 0) throw new JobDataError('atualidades: empty source allowlist', 'config');
  const recent = unwrapRows<{ title: string }>(await ctx.db.from('atualidades_items').select('title').order('created_at', { ascending: false }).limit(40), 'atualidades_items');
  const month = Number(weekStart.slice(5, 7));

  const research = await runText(ctx.ai, {
    task: getTask('atualidades.research'),
    // Brazilian general elections fall in October of even years: no candidate or party evaluation (ENM-09.4).
    input: { weekStart: addDays(weekStart, -7), weekEnd: addDays(weekStart, -1), allowedDomains: allowed, recentTitles: recent.map((r) => r.title), electionPeriod: Number(weekStart.slice(0, 4)) % 2 === 0 && month >= 7 && month <= 10 },
    scope: { userId: null, feature: 'ENM-09' },
  });
  if (research.status !== 'ok') throw new JobDataError(`atualidades.research: ${research.status}`, 'ai_failed');
  const cited = webSourcesOf(research.content).filter((s) => isAllowedDomain(s.url, allowed));
  if (cited.length === 0) return { status: 'skipped', reason: 'no_cited_sources' };

  const skills = unwrapRows<{ code: string; description: string | null }>(await ctx.db.from('enem_skills').select('code,description').in('area', ['CH', 'CN', 'LC']), 'enem_skills');
  const structured = await runPrompt(ctx.ai, {
    task: getTask('atualidades.structure'),
    schema: AtualidadesDigest as unknown as z.ZodType<Digest>,
    input: { weekStart, researchText: research.data.slice(0, 40_000), citedUrls: cited.map((c) => ({ url: c.url, title: c.title })), skills },
    scope: { userId: null, feature: 'ENM-09' },
  });
  if (structured.result.status !== 'ok') throw new JobDataError(`atualidades.structure: ${structured.result.status}`, 'ai_failed');
  const items = validateDigest(structured.result.data as Digest, cited, allowed, new Set(skills.map((s) => s.code)));
  if (items.length < ATUALIDADES_MIN_ITEMS) {
    ctx.log.info({ weekStart, items: items.length, note: (structured.result.data as Digest).skipped_note }, 'atualidades: week skipped');
    return { status: 'skipped', reason: 'too_few_items' };
  }

  const bank = await ensureAtualidadesSubject(ctx);
  const digestId = crypto.randomUUID();
  unwrap(await ctx.db.from('atualidades_digests').insert({ id: digestId, week_start: weekStart, status: 'draft' }), 'atualidades_digests');
  for (const [position, item] of items.entries()) {
    const questionIds: string[] = [];
    for (const q of item.questions) {
      let payload;
      try {
        const why = new Map(q.distractor_rationales.map((r) => [r.label, r.why] as const));
        payload = parseQuestionPayload('mcq_single', { options: q.alternatives.map((a) => ({ id: a.label, text: a.text_md, rationale: a.label === q.answer ? q.explanation_md : (why.get(a.label) ?? '—') })), correct: q.answer });
      } catch {
        continue;
      }
      const id = crypto.randomUUID();
      unwrap(
        await ctx.db.from('questions').insert({
          id,
          subject_id: bank.subjectId,
          node_id: bank.nodeId,
          type: 'mcq_single',
          stem: q.comando_md,
          texto_base: { kind: 'written', content_md: q.texto_base_md, label: 'Texto elaborado pelo Studify' },
          payload,
          explanation: q.explanation_md,
          difficulty_band: q.difficulty,
          difficulty: q.difficulty === 'facil' ? 2 : q.difficulty === 'media' ? 3 : 4,
          enem_skill_code: q.skill_code,
          enem_style: true,
          origin: 'generated',
          prompt_version: getTask('atualidades.structure').promptVersion,
          status: 'active',
          review_status: 'approved',
        }),
        'questions',
      );
      questionIds.push(id);
    }
    unwrap(
      await ctx.db.from('atualidades_items').insert({
        digest_id: digestId,
        position,
        title: item.title,
        summary_md: item.summary_md,
        why_md: item.why_md,
        areas: item.areas,
        skill_codes: item.skill_codes,
        redacao_axes: item.redacao_axes,
        repertorio: item.repertorio,
        sources: item.sources,
        question_ids: questionIds,
      }),
      'atualidades_items',
    );
  }
  return { status: 'drafted', digestId, items: items.length };
}

/** ENM-09.5: push to students with an active ENEM goal who opted in (profiles.settings.notify_atualidades). */
export async function handleAtualidadesNotify(ctx: OperationContext, data: Record<string, unknown>): Promise<{ sent: number }> {
  const digestId = z.uuid().parse(data.digest_id);
  const goals = unwrapRows<{ user_id: string }>(await ctx.db.from('goals').select('user_id').eq('mode', 'enem').eq('status', 'active').is('deleted_at', null), 'goals');
  const users = [...new Set(goals.map((g) => g.user_id))];
  if (users.length === 0) return { sent: 0 };
  const profiles = unwrapRows<{ id: string; settings: { notify_atualidades?: boolean } | null }>(await ctx.db.from('profiles').select('id,settings').in('id', users).is('deleted_at', null), 'profiles');
  let sent = 0;
  for (const p of profiles) {
    if (p.settings?.notify_atualidades !== true) continue;
    await ctx.execute('notify.dispatch', { user_id: p.id, type: 'atualidades_published', data: { digest_id: digestId } }, { singletonKey: `atualidades_published:${digestId}:${p.id}` });
    sent++;
  }
  return { sent };
}

export const jobs: OperationDefinition<any>[] = [
  // Monday 06:00 Brasília (09:00 UTC); the draft waits for an admin to publish it.
  { name: 'atualidades.weekly', schedule: '0 9 * * 1', handler: async (ctx, data) => void (await handleAtualidadesWeekly(ctx, data ?? {})) },
  { name: 'atualidades.notify', handler: async (ctx, data) => void (await handleAtualidadesNotify(ctx, data)) },
];
