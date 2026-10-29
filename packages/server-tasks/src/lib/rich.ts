// Rich notification payloads (PLT-05, api.md §9.1). The push service builds one per message at send time,
// enriching the producer's ids from the database (subject color, scores, names), and attaches it to the
// push data; the Android module draws it natively and the inbox keeps it. Any failure (a missing row, a
// payload that does not validate or is too big for FCM) falls back to a `basic` payload with the same copy,
// so enrichment can never cost the student the notification.
import { materialDoneRich, parseRichNotification, type RichNotification, type RichNotificationInput } from '@studify/shared';

export { liveKeyOf, liveRich, type LiveJobRow } from '@studify/shared';
import type { Sql } from '../framework/db.ts';

export type RichChannel = 'reviews' | 'plan' | 'class' | 'processing';

export interface RichSource {
  type: string;
  channel: RichChannel;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** FCM data payloads are limited to 4 KB; the rich JSON travels inside one of its fields. */
export const RICH_MAX_BYTES = 3000;

const CHANNEL_ACCENT: Record<RichChannel, string> = {
  reviews: '#15803D',
  plan: '#4F46E5',
  class: '#BE185D',
  processing: '#0369A1',
};
const ENEM_ACCENT = '#0E7490';

const GLYPH: Record<string, RichNotificationInput['glyph']> = {
  material_ready: 'book',
  material_failed: 'alert',
  essay_graded: 'pen',
  podcast_ready: 'podcast',
  export_ready: 'check',
  content_fixed: 'check',
  duel_challenge: 'people',
  duel_finished: 'trophy',
  battle_starting: 'people',
  subject_shared: 'book',
  join_request: 'people',
  content_flag_review: 'alert',
  report_created: 'alert',
  divide_merged: 'people',
  atualidades_published: 'news',
  retro_ready: 'sparkles',
  reta_final_start: 'calendar',
  enem_eve: 'calendar',
  enem_between_days: 'calendar',
  enem_exam_day: 'calendar',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function one<T extends Record<string, unknown>>(sql: Sql, text: string, values: unknown[]): Promise<T | null> {
  const { rows } = await sql.query<T>(text, values);
  return (rows[0] as T | undefined) ?? null;
}

function deepLinkOf(src: RichSource): string | undefined {
  const link = str(src.data.deep_link);
  return link && link.startsWith('studify://') ? link : undefined;
}

/** The plain payload every type falls back to. */
export function basicRich(src: RichSource): RichNotification {
  const firstId = Object.entries(src.data).find(([k, v]) => k.endsWith('_id') && typeof v === 'string')?.[1];
  const key = `${src.type}:${typeof firstId === 'string' ? firstId : 'latest'}`.slice(0, 80);
  return parseRichNotification({
    v: 1,
    key,
    template: 'basic',
    channel: src.channel,
    title: src.title.slice(0, 80),
    body: src.body.slice(0, 240),
    glyph: GLYPH[src.type] ?? 'sparkles',
    accent: CHANNEL_ACCENT[src.channel],
    deep_link: deepLinkOf(src),
  })!;
}

/** Builds and validates the rich payload; never throws. */
export async function richFor(sql: Sql, userId: string, src: RichSource): Promise<RichNotification> {
  let built: RichNotificationInput | null = null;
  try {
    built = await enrich(sql, userId, src);
  } catch {
    built = null;
  }
  if (built) {
    const parsed = parseRichNotification(built);
    if (parsed && JSON.stringify(parsed).length <= RICH_MAX_BYTES) return parsed;
  }
  return basicRich(src);
}

async function subjectOf(sql: Sql, subjectId: unknown): Promise<{ name: string; color: string } | null> {
  if (!str(subjectId)) return null;
  return one<{ name: string; color: string }>(sql, `select name, color from public.subjects where id = $1`, [subjectId]);
}

async function nameOf(sql: Sql, userId: string, classGroupId: unknown): Promise<string> {
  const row = await one<{ name: string }>(
    sql,
    `select coalesce(m.nickname, p.display_name) as name
       from public.profiles p
       left join public.class_group_members m on m.user_id = p.id and m.class_group_id = $2
      where p.id = $1`,
    [userId, str(classGroupId)],
  );
  return row?.name ?? 'Colega';
}

function base(src: RichSource, extra: Partial<RichNotificationInput> & Pick<RichNotificationInput, 'key' | 'template'>): RichNotificationInput {
  return {
    v: 1,
    channel: src.channel,
    title: src.title.slice(0, 80),
    body: src.body.slice(0, 240),
    glyph: GLYPH[src.type] ?? 'sparkles',
    accent: CHANNEL_ACCENT[src.channel],
    deep_link: deepLinkOf(src),
    ...extra,
  };
}

async function enrich(sql: Sql, userId: string, src: RichSource): Promise<RichNotificationInput | null> {
  const d = src.data;
  switch (src.type) {
    case 'material_ready':
    case 'material_failed': {
      const docId = str(d.document_id);
      const subjectId = str(d.subject_id);
      if (!docId || !subjectId) return null;
      const failed = src.type === 'material_failed';
      const job = failed
        ? await one<{ stage: string | null }>(sql, `select stage from public.ai_jobs where document_id = $1 order by created_at desc limit 1`, [docId])
        : null;
      return materialDoneRich({ documentId: docId, subjectId, subject: await subjectOf(sql, subjectId), failed, stage: job?.stage ?? null, title: src.title, body: src.body });
    }
    case 'essay_graded': {
      const essayId = str(d.essay_id);
      if (!essayId) return null;
      const essay = await one<{ total: number | null; competencias: Record<string, { score?: number }> | null; created_at: string }>(
        sql,
        `select total, competencias, created_at from public.essays where id = $1 and user_id = $2`,
        [essayId, userId],
      );
      if (!essay || essay.total === null) return null;
      const previous = await one<{ total: number }>(
        sql,
        `select total from public.essays
          where user_id = $1 and id <> $2 and kind = 'enem_redacao' and status = 'graded' and total is not null and created_at < $3
          order by created_at desc limit 1`,
        [userId, essayId, essay.created_at],
      );
      const breakdown = ['c1', 'c2', 'c3', 'c4', 'c5'].flatMap((c, i) => {
        const score = essay.competencias?.[c]?.score;
        return typeof score === 'number' ? [{ label: `C${i + 1}`, value: Math.min(1, Math.max(0, score / 200)) }] : [];
      });
      const link = deepLinkOf(src);
      return base(src, {
        key: `essay:${essayId}`,
        template: 'score',
        accent: ENEM_ACCENT,
        score: { value: essay.total, max: 1000, label: 'Nota da redação', ...(previous ? { delta: essay.total - previous.total } : {}), breakdown },
        actions: link ? [{ id: 'open', label: 'Ver correção', kind: 'open', deep_link: link }] : [],
      });
    }
    case 'podcast_ready': {
      const episodeId = str(d.episode_id);
      if (!episodeId) return null;
      const ep = await one<{ title: string; duration_ms: number | null; subject_id: string | null }>(
        sql,
        `select title, duration_ms, subject_id from public.podcast_episodes where id = $1`,
        [episodeId],
      );
      if (!ep?.duration_ms) return null;
      const subject = await subjectOf(sql, ep.subject_id);
      const link = deepLinkOf(src);
      return base(src, {
        key: `podcast:${episodeId}`,
        template: 'media',
        body: ep.title.slice(0, 240),
        sub: subject?.name,
        accent: subject?.color ?? CHANNEL_ACCENT.processing,
        media: { kind: 'podcast', duration_s: Math.max(1, Math.round(ep.duration_ms / 1000)) },
        actions: link ? [{ id: 'open', label: 'Ouvir agora', kind: 'open', deep_link: link }] : [],
      });
    }
    case 'duel_challenge':
    case 'duel_finished': {
      const duelId = str(d.duel_id);
      if (!duelId) return null;
      const duel = await one<{ challenger_id: string; opponent_id: string; challenger_score: number | null; opponent_score: number | null; quiz_id: string }>(
        sql,
        `select challenger_id, opponent_id, challenger_score, opponent_score, quiz_id from public.duels where id = $1`,
        [duelId],
      );
      if (!duel) return null;
      const iAmChallenger = duel.challenger_id === userId;
      const otherId = iAmChallenger ? duel.opponent_id : duel.challenger_id;
      const them = str(d.nome) ?? (await nameOf(sql, otherId, d.class_group_id));
      const myScore = iAmChallenger ? duel.challenger_score : duel.opponent_score;
      const theirScore = iAmChallenger ? duel.opponent_score : duel.challenger_score;
      const finished = src.type === 'duel_finished';
      const result = str(d.result);
      const state = !finished ? 'challenge' : result === 'win' ? 'won' : result === 'lose' ? 'lost' : 'draw';
      const link = deepLinkOf(src);
      return base(src, {
        key: `duel:${duelId}`,
        template: 'duel',
        duel: {
          me: { name: 'Você', ...(finished && myScore !== null ? { score: myScore } : {}) },
          them: { name: them.slice(0, 40), ...(finished && theirScore !== null ? { score: theirScore } : {}) },
          state,
          ...(str(d.materia) ? { subject: str(d.materia)!.slice(0, 40) } : {}),
        },
        group: 'turma',
        actions: [
          ...(link ? [{ id: 'open', label: finished ? 'Ver resultado' : 'Aceitar duelo', kind: 'open' as const, deep_link: link }] : []),
          ...(!finished ? [{ id: 'later', label: 'Mais tarde', kind: 'snooze' as const, snooze_min: 60 }] : []),
        ],
      });
    }
    case 'atualidades_published': {
      const digestId = str(d.digest_id);
      if (!digestId) return null;
      const { rows } = await sql.query<{ title: string }>(
        `select title from public.atualidades_items where digest_id = $1 and not withdrawn order by position limit 5`,
        [digestId],
      );
      if (rows.length === 0) return null;
      return base(src, {
        key: `atualidades:${digestId}`,
        template: 'digest',
        accent: ENEM_ACCENT,
        digest: { lines: rows.map((r) => `• ${r.title}`.slice(0, 80)) },
      });
    }
    case 'retro_ready': {
      const retro = await one<{ id: string; title: string; stats: { active_minutes?: number; cards_reviewed?: number; questions_answered?: number } }>(
        sql,
        `select id, title, stats from public.retrospectives where user_id = $1 order by generated_at desc limit 1`,
        [userId],
      );
      if (!retro) return null;
      const s = retro.stats ?? {};
      const stats = [
        { label: 'horas de estudo', value: String(Math.round((s.active_minutes ?? 0) / 60)) },
        { label: 'cartões', value: String(s.cards_reviewed ?? 0) },
        { label: 'questões', value: String(s.questions_answered ?? 0) },
      ];
      const link = `studify://retro/${retro.id}`;
      return base(src, {
        key: `retro:${retro.id}`,
        template: 'retro',
        deep_link: link,
        retro: { headline: retro.title.slice(0, 60), stats },
        actions: [{ id: 'open', label: 'Ver Retrospectiva', kind: 'open', deep_link: link }],
      });
    }
    case 'reta_final_start':
    case 'enem_eve':
    case 'enem_between_days':
    case 'enem_exam_day': {
      const edition = await one<{ day1_date: string | null; day2_date: string | null; start_time: string | null; timezone: string | null }>(
        sql,
        `select day1_date::text, day2_date::text, start_time::text, timezone from public.enem_editions
          where day2_date >= current_date - 1 or day1_date >= current_date - 1 order by year limit 1`,
        [],
      );
      const target = edition ? nextEnemStart(edition) : null;
      if (!target) return null;
      const chips = src.type === 'enem_eve' || src.type === 'enem_exam_day' ? ['Documento com foto', 'Caneta preta transparente'] : [];
      const link = deepLinkOf(src);
      return base(src, {
        key: `enem:${str(d.goal_id) ?? 'goal'}`,
        template: 'countdown',
        accent: ENEM_ACCENT,
        countdown: { target_at: target, label: 'ENEM', chips },
        actions: link ? [{ id: 'open', label: 'Ver Reta Final', kind: 'open', deep_link: link }] : [],
      });
    }
    case 'divide_merged': {
      const planId = str(d.divide_plan_id);
      if (!planId) return null;
      const plan = await one<{ title: string; subject_id: string }>(sql, `select title, subject_id from public.divide_plans where id = $1`, [planId]);
      if (!plan) return null;
      const subject = await subjectOf(sql, plan.subject_id);
      const link = deepLinkOf(src);
      return base(src, {
        key: `divide:${planId}`,
        template: 'message',
        accent: subject?.color ?? CHANNEL_ACCENT.class,
        group: 'turma',
        message: { sender: 'Turma', text: src.body.slice(0, 240), conversation: plan.title.slice(0, 40) },
        actions: link ? [{ id: 'open', label: 'Ver resumo', kind: 'open', deep_link: link }] : [],
      });
    }
    default:
      return null;
  }
}

/**
 * The next ENEM day start as an ISO instant. The edition's start time is local to its time zone (Brasília
 * by default, UTC−3 since 2019).
 */
export function nextEnemStart(e: { day1_date: string | null; day2_date: string | null; start_time: string | null }, now = new Date()): string | null {
  const start = (e.start_time ?? '13:30').slice(0, 5);
  for (const day of [e.day1_date, e.day2_date]) {
    if (!day) continue;
    const at = new Date(`${day}T${start}:00-03:00`);
    if (at.getTime() > now.getTime() - 6 * 3600_000) return at.toISOString();
  }
  return null;
}
