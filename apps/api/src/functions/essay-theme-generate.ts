// essay-theme-generate (ENM-05.8 "Me dá um tema"; api §4.9). Picks a predicted training theme or a past ENEM
// theme (no AI), or writes the full proposal for an Atualidades item or a theme the student typed
// (essay.themePrompt). Motivating texts keep only the URLs of the given sources; a typed theme gets context texts
// written by Studify, never attributed to real outlets.
import { getTask } from '@studify/prompts';
import { ApiFailure, EssayThemeGenerateReqSchema, type EssayThemeGenerateReq, type EssayThemeGenerateRes, type EssayThemePrompt } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { requireAllowedText } from '../shared-p4/moderation.ts';

/** The standard ENEM instruction (Cartilha do Participante), used for past themes. */
export const ENEM_INSTRUCTION =
  'A partir da leitura dos textos motivadores e com base nos conhecimentos construídos ao longo de sua formação, redija texto dissertativo-argumentativo em modalidade escrita formal da língua portuguesa sobre o tema proposto, apresentando proposta de intervenção que respeite os direitos humanos. Selecione, organize e relacione, de forma coerente e coesa, argumentos e fatos para defesa de seu ponto de vista.';

interface ThemeOut {
  title: string;
  axis: string;
  instruction: string;
  motivating_texts: Array<{ kind: 'summary' | 'data' | 'context'; text: string; source_url: string | null; source_name: string | null }>;
}

/** Deterministic pick per user and day (no Math.random), so a retry shows the same theme. */
function pick<T>(items: readonly T[], seed: string): T | undefined {
  if (items.length === 0) return undefined;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return items[h % items.length];
}

function promptOf(out: ThemeOut, allowedUrls: ReadonlySet<string>): EssayThemePrompt {
  const texts = out.motivating_texts
    .filter((t) => t.source_url === null || allowedUrls.has(t.source_url))
    .map((t, i) => ({
      label: `Texto ${['I', 'II', 'III', 'IV'][i] ?? i + 1}`,
      kind: t.kind === 'context' ? ('excerpt' as const) : t.kind,
      text_md: t.source_url ? t.text : `${t.text}\n\n_Texto elaborado pelo Studify._`,
      source_name: t.source_url ? t.source_name : null,
      source_url: t.source_url,
    }));
  return { instruction: out.instruction, motivating_texts: texts };
}

export const handler = defineFunction<EssayThemeGenerateReq>({
  name: 'essay-theme-generate',
  // Calls Claude outside a stream: runs as a job, the request answers 202 running (ADR 0009).
  deferred: true,
  mutating: true,
  aiCall: true,
  input: EssayThemeGenerateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const today = ctx.now.toISOString().slice(0, 10);
    const seed = `${userId}|${today}|${input.axis ?? ''}`;

    if (input.source === 'predicted') {
      const res = await db.from('essay_themes').select('id, title, axis, valid_until').eq('source', 'predicted').is('deleted_at', null).order('created_at', { ascending: false }).limit(40);
      if (res.error) throw res.error;
      const used = await db.from('essays').select('theme_id').eq('user_id', userId).not('theme_id', 'is', null);
      if (used.error) throw used.error;
      const usedIds = new Set((used.data as Array<{ theme_id: string }>).map((r) => r.theme_id));
      const active = (res.data as Array<{ id: string; title: string; axis: string | null; valid_until: string | null }>).filter(
        (t) => (!t.valid_until || t.valid_until >= today) && (!input.axis || (t.axis ?? '').toLowerCase() === input.axis.toLowerCase()),
      );
      const fresh = active.filter((t) => !usedIds.has(t.id));
      const chosen = pick(fresh.length ? fresh : active, seed);
      if (!chosen) throw new ApiFailure('not_found', { message: 'Os temas de treino deste mês ainda não saíram. Que tal um tema de uma edição passada?' });
      return ctx.json({ theme_id: chosen.id, title: chosen.title, source: 'predicted' } satisfies EssayThemeGenerateRes);
    }

    if (input.source === 'past_enem') {
      const past = await db.from('enem_redacao_themes').select('edition_year, theme').eq('application', 'regular').order('edition_year', { ascending: false });
      if (past.error) throw past.error;
      const chosen = pick(past.data as Array<{ edition_year: number; theme: string }>, seed);
      if (!chosen) throw new ApiFailure('not_found');
      const existing = await db.from('essay_themes').select('id').eq('source', 'past_enem').eq('edition_year', chosen.edition_year).is('deleted_at', null).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return ctx.json({ theme_id: existing.data.id as string, title: chosen.theme, source: 'past_enem' } satisfies EssayThemeGenerateRes);
      const id = deps.newId();
      const prompt: EssayThemePrompt = { instruction: ENEM_INSTRUCTION, motivating_texts: [] };
      const inserted = await db.from('essay_themes').insert({ id, title: chosen.theme, source: 'past_enem', edition_year: chosen.edition_year, prompt, created_by: null });
      if (inserted.error) throw inserted.error;
      return ctx.json({ theme_id: id, title: chosen.theme, source: 'past_enem' } satisfies EssayThemeGenerateRes, 201);
    }

    // Atualidades item or a typed theme: the full proposal is written by essay.themePrompt.
    let item: { id: string; title: string; summary_md: string; sources: Array<{ url: string; name: string }> } | null = null;
    if (input.source === 'atualidades') {
      let q = db.from('atualidades_items').select('id, digest_id, title, summary_md, sources, withdrawn').eq('withdrawn', false);
      q = input.atualidades_item_id ? q.eq('id', input.atualidades_item_id) : q.order('created_at', { ascending: false }).limit(1);
      const res = await q.maybeSingle();
      if (res.error) throw res.error;
      const row = res.data as { id: string; digest_id: string; title: string; summary_md: string; sources: Array<{ url: string; name: string }> } | null;
      if (!row) throw new ApiFailure('not_found');
      const digest = await db.from('atualidades_digests').select('status').eq('id', row.digest_id).maybeSingle();
      if (digest.error) throw digest.error;
      if (digest.data?.status !== 'published') throw new ApiFailure('not_found');
      const reused = await db.from('essay_themes').select('id, title').eq('source', 'atualidades').contains('connections', [{ atualidades_item_id: row.id }]).is('deleted_at', null).maybeSingle();
      if (reused.error) throw reused.error;
      if (reused.data) return ctx.json({ theme_id: reused.data.id as string, title: reused.data.title as string, source: 'atualidades' } satisfies EssayThemeGenerateRes);
      item = row;
    } else {
      await requireAllowedText(deps, userId, input.title!, 'ENM-05');
    }

    const built = getTask('essay.themePrompt').build({
      source: input.source,
      title: input.source === 'custom' ? input.title! : null,
      item: item ? { title: item.title, summary: item.summary_md, sources: item.sources.map((s) => ({ url: s.url, name: s.name })) } : null,
    });
    const out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'essay.themePrompt', ctx: budgetCtxFor(null, userId, 'ENM-05', 'user') })) as ThemeOut;
    const allowed = new Set((item?.sources ?? []).map((s) => s.url));
    const id = deps.newId();
    const row: Record<string, unknown> =
      input.source === 'custom'
        ? { id, title: out.title, axis: out.axis, source: 'custom', prompt: promptOf(out, new Set()), created_by: userId }
        : { id, title: out.title, axis: out.axis, source: 'atualidades', prompt: promptOf(out, allowed), connections: [{ atualidades_item_id: item!.id }], created_by: null };
    const inserted = await db.from('essay_themes').insert(row);
    if (inserted.error) throw inserted.error;
    return ctx.json({ theme_id: id, title: out.title, source: input.source } satisfies EssayThemeGenerateRes, 201);
  },
});

export default handler;
