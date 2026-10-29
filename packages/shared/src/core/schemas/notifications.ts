// Rich notifications (PLT-05, api.md §9.1). One payload drives three renderers: the Android module
// `studify-notify` (custom layouts, drawn graphics and Android 16 Live Updates), the in-app Central de
// notificações, and the plain title/body fallback for devices without the module. Copy is PT-BR and short;
// the title and body alone must still make sense.
import { z } from 'zod';

export const RICH_TEMPLATES = [
  'basic',
  'progress',
  'countdown',
  'goal',
  'duel',
  'score',
  'card',
  'achievement',
  'retro',
  'media',
  'digest',
  'message',
] as const;
export type RichTemplate = (typeof RICH_TEMPLATES)[number];

/** The four user-facing channels (PLT-05.7) plus `live` for ongoing progress, which never makes a sound. */
export const RICH_CHANNELS = ['reviews', 'plan', 'class', 'processing', 'live'] as const;
export type RichChannel = (typeof RICH_CHANNELS)[number];

/** Icons the native module ships as vector drawables (and the app maps to Ionicons). */
export const RICH_GLYPHS = [
  'book',
  'cards',
  'quiz',
  'trophy',
  'flame',
  'calendar',
  'podcast',
  'pen',
  'camera',
  'people',
  'sparkles',
  'timer',
  'alert',
  'check',
  'map',
  'news',
] as const;
export type RichGlyph = (typeof RICH_GLYPHS)[number];

/**
 * What a button does. `open` follows its deep link; the others run without opening the app: `snooze`
 * shows the notification again later, `reveal` turns a card notification to its answer, and the two
 * ratings are queued for the app to record as reviews (MEM-02, offline-first like the widget).
 */
export const RICH_ACTION_KINDS = ['open', 'snooze', 'dismiss', 'reveal', 'rate_again', 'rate_good'] as const;
export type RichActionKind = (typeof RICH_ACTION_KINDS)[number];

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const DeepLink = z.string().regex(/^studify:\/\/[^\s]{1,300}$/);
const Fraction = z.number().min(0).max(1);
const Text = (max: number) => z.string().min(1).max(max);

export const RichActionSchema = z
  .object({
    id: Text(32),
    label: Text(28),
    kind: z.enum(RICH_ACTION_KINDS),
    deep_link: DeepLink.optional(),
    snooze_min: z.int().min(5).max(240).optional(),
  })
  .refine((a) => a.kind !== 'open' || a.deep_link !== undefined, { message: 'open needs deep_link', path: ['deep_link'] });
export type RichAction = z.infer<typeof RichActionSchema>;

export const PROGRESS_STEP_STATES = ['done', 'active', 'pending', 'failed'] as const;

/** Uber-style live progress: named steps, overall fraction and an estimate. */
export const RichProgressSchema = z.object({
  steps: z.array(z.object({ label: Text(24), state: z.enum(PROGRESS_STEP_STATES) })).min(1).max(6),
  fraction: Fraction,
  state: z.enum(['running', 'done', 'failed']),
  /** Seconds left, when known. */
  eta_s: z.int().min(0).max(86_400).optional(),
});

export const RichCountdownSchema = z.object({
  /** ISO instant of the event (a test, the ENEM day, a battle start). */
  target_at: z.iso.datetime({ offset: true }),
  label: Text(40),
  /** Readiness for a test (GOL-08), drawn as a ring. */
  readiness: Fraction.optional(),
  /** Short facts under the title ("6 tópicos", "Cai: Genética"). */
  chips: z.array(Text(24)).max(4).default([]),
});

export const RichGoalSchema = z.object({
  done_min: z.int().min(0).max(1440),
  goal_min: z.int().min(1).max(1440),
  streak: z.int().min(0).max(10_000),
  shields: z.int().min(0).max(2),
});

const DuelSide = z.object({ name: Text(40), score: z.int().min(0).max(100_000).optional() });
export const RichDuelSchema = z.object({
  me: DuelSide,
  them: DuelSide,
  state: z.enum(['challenge', 'your_turn', 'waiting', 'won', 'lost', 'draw']),
  subject: Text(40).optional(),
});

export const RichScoreSchema = z.object({
  value: z.number().min(0).max(100_000),
  max: z.number().positive().max(100_000),
  label: Text(40),
  delta: z.number().min(-100_000).max(100_000).optional(),
  /** Up to 5 bars (the redação competências, ENEM areas). */
  breakdown: z.array(z.object({ label: Text(20), value: Fraction })).max(5).default([]),
});

export const RichCardSchema = z.object({
  card_id: z.string().min(1).max(64),
  front: Text(200),
  back: z.string().max(300).optional(),
  /** Cards due today, including this one. */
  due: z.int().min(0).max(100_000),
  subject: Text(40).optional(),
});

export const RichAchievementSchema = z.object({ name: Text(40), criterion: Text(120), emoji: Text(8).default('🏆') });

export const RichRetroSchema = z.object({
  headline: Text(60),
  stats: z.array(z.object({ label: Text(24), value: Text(16) })).min(1).max(3),
});

export const RichMediaSchema = z.object({ kind: z.enum(['podcast']), duration_s: z.int().min(1).max(36_000) });

export const RichDigestSchema = z.object({ lines: z.array(Text(80)).min(1).max(6) });

export const RichMessageSchema = z.object({ sender: Text(40), text: Text(240), conversation: Text(40).optional() });

const BLOCK_OF: Record<RichTemplate, string | null> = {
  basic: null,
  progress: 'progress',
  countdown: 'countdown',
  goal: 'goal',
  duel: 'duel',
  score: 'score',
  card: 'card',
  achievement: 'achievement',
  retro: 'retro',
  media: 'media',
  digest: 'digest',
  message: 'message',
};

export const RichNotificationSchema = z
  .object({
    v: z.literal(1),
    /** Stable key: a notification with the same key replaces the previous one (live updates). */
    key: Text(80),
    template: z.enum(RICH_TEMPLATES),
    channel: z.enum(RICH_CHANNELS),
    title: Text(80),
    body: z.string().max(240),
    /** Small line next to the app name ("Biologia", "Turma 2B"). */
    sub: z.string().max(60).optional(),
    glyph: z.enum(RICH_GLYPHS).default('sparkles'),
    /** Subject or feature color. */
    accent: Hex.optional(),
    deep_link: DeepLink.optional(),
    /** Notifications sharing a group are bundled with a summary. */
    group: Text(40).optional(),
    actions: z.array(RichActionSchema).max(3).default([]),
    progress: RichProgressSchema.optional(),
    countdown: RichCountdownSchema.optional(),
    goal: RichGoalSchema.optional(),
    duel: RichDuelSchema.optional(),
    score: RichScoreSchema.optional(),
    card: RichCardSchema.optional(),
    achievement: RichAchievementSchema.optional(),
    retro: RichRetroSchema.optional(),
    media: RichMediaSchema.optional(),
    digest: RichDigestSchema.optional(),
    message: RichMessageSchema.optional(),
  })
  .superRefine((n, ctx) => {
    const block = BLOCK_OF[n.template];
    if (block && (n as Record<string, unknown>)[block] === undefined) {
      ctx.addIssue({ code: 'custom', message: `template ${n.template} needs its ${block} block`, path: [block] });
    }
    if (n.template === 'progress' && n.channel !== 'live' && n.progress?.state === 'running') {
      ctx.addIssue({ code: 'custom', message: 'running progress goes on the live channel', path: ['channel'] });
    }
    const ids = new Set<string>();
    for (const a of n.actions) {
      if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate action id ${a.id}`, path: ['actions'] });
      ids.add(a.id);
    }
  });
export type RichNotification = z.infer<typeof RichNotificationSchema>;
export type RichNotificationInput = z.input<typeof RichNotificationSchema>;

/** Validates and fills defaults; null when the payload is not a usable rich notification. */
export function parseRichNotification(raw: unknown): RichNotification | null {
  const r = RichNotificationSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------- live progress for server jobs

/** Steps shown for each kind of long job (the same labels on the phone, the server and the inbox). */
export const LIVE_JOB_STEPS = {
  // The app's processing screen, its subject card and the live notification all show these steps (labels fit the
  // notification's 24 characters). Weights are each step's share of the bar, roughly its share of the time: the
  // content step does most of the AI work.
  'ingest.document': [
    { stages: ['S0', 'transcription'], label: 'Lendo o material', weight: 0.1 },
    { stages: ['S1', 'S1_merge'], label: 'Montando o mapa', weight: 0.15 },
    { stages: ['S2', 'S3'], label: 'Encontrando conceitos', weight: 0.25 },
    { stages: ['S4', 'done'], label: 'Resumos e cartões', weight: 0.5 },
  ],
  // The script is the long call (0–0.6); the voices fill 0.6–0.95 line by line.
  'podcast.generate': [
    { stages: ['script'], label: 'Roteiro', weight: 0.6 },
    { stages: ['audio'], label: 'Vozes', weight: 0.35 },
    { stages: ['done'], label: 'Pronto', weight: 0.05 },
  ],
  'essay.grade': [
    { stages: ['grading'], label: 'Competências', weight: 0.7 },
    { stages: ['repertorio'], label: 'Repertório', weight: 0.25 },
    { stages: ['done'], label: 'Nota', weight: 0.05 },
  ],
  'pp.generate': [
    { stages: ['extract'], label: 'Provas antigas' },
    { stages: ['generate'], label: 'Questões' },
    { stages: ['done'], label: 'Prova pronta' },
  ],
} as const satisfies Record<string, ReadonlyArray<{ stages: readonly string[]; label: string; weight?: number }>>;
export type LiveJobType = keyof typeof LIVE_JOB_STEPS;

export function isLiveJobType(type: string): type is LiveJobType {
  return Object.hasOwn(LIVE_JOB_STEPS, type);
}

/** Jobs whose ai_jobs.progress is the share of the current stage (the worker counts items per stage). */
const STAGE_LOCAL_PROGRESS: ReadonlySet<string> = new Set(['ingest.document']);

/**
 * The progress block for a job at `stage` (ai_jobs.stage) with `status`. A stage the table does not know
 * keeps the first step active, so a new pipeline stage never breaks the notification. Each step owns a band
 * of the bar (its weight, equal when none is given) and the fraction never leaves the current band, so the bar
 * only moves forward: a stage-local progress fills the band; an overall one is clamped to it.
 */
export function liveJobProgress(
  type: LiveJobType,
  stage: string | null,
  status: string,
  progress: number | null,
): z.infer<typeof RichProgressSchema> {
  const steps = LIVE_JOB_STEPS[type];
  const n = steps.length;
  const succeeded = status === 'succeeded';
  const failed = status === 'failed' || status === 'cancelled';
  let current = steps.findIndex((s) => (s.stages as readonly string[]).includes(stage ?? ''));
  if (current < 0) current = 0;
  if (succeeded) current = n;
  const out = steps.map((s, i) => ({
    label: s.label,
    state: (i < current ? 'done' : i === current ? (failed ? 'failed' : 'active') : 'pending') as (typeof PROGRESS_STEP_STATES)[number],
  }));
  let fraction = 1;
  if (!succeeded) {
    const weights = steps.map((s) => ('weight' in s ? s.weight : 1 / n));
    const total = weights.reduce((a, b) => a + b, 0);
    const start = weights.slice(0, Math.min(current, n)).reduce((a, b) => a + b, 0) / total;
    const width = (weights[Math.min(current, n - 1)] ?? 0) / total;
    const end = start + width;
    if (progress === null) fraction = start + width * 0.1;
    else if (STAGE_LOCAL_PROGRESS.has(type)) fraction = start + width * Math.min(1, Math.max(0, progress));
    else fraction = Math.min(end, Math.max(start, progress));
    fraction = Math.min(0.99, fraction);
  }
  return { steps: out, fraction: Math.round(fraction * 100) / 100, state: succeeded ? 'done' : failed ? 'failed' : 'running' };
}

// ---------------------------------------------------------------- live progress payloads (notify.live and the app)

export interface LiveJobRow {
  id: string;
  type: string;
  stage: string | null;
  status: string;
  progress: number | null;
  user_id: string | null;
  subject_id: string | null;
  document_id: string | null;
  started_at: string | null;
}

const LIVE_COPY: Record<LiveJobType, { title: string; glyph: RichGlyph }> = {
  'ingest.document': { title: 'Preparando seu material', glyph: 'book' },
  'podcast.generate': { title: 'Gravando seu podcast', glyph: 'podcast' },
  'essay.grade': { title: 'Corrigindo sua redação', glyph: 'pen' },
  'pp.generate': { title: 'Montando sua Prova Provável', glyph: 'quiz' },
};

/** Live key of a job: the material's final "pronto" notification reuses it and replaces the live one. */
export function liveKeyOf(job: Pick<LiveJobRow, 'id' | 'type' | 'document_id'>): string {
  return job.type === 'ingest.document' && job.document_id ? `doc:${job.document_id}` : `job:${job.id}`;
}

/**
 * Seconds left for work that is `fraction` done after `elapsedS`, extrapolated from the pace so far. Null until the
 * estimate means something: a sixth of the work done and 20 s elapsed. The live notification and the app's progress
 * cards use the same estimate, so they never disagree.
 */
export function etaSeconds(fraction: number, elapsedS: number): number | null {
  if (!(fraction >= 0.16) || !(elapsedS > 20) || fraction >= 1) return null;
  return Math.round((elapsedS * (1 - fraction)) / fraction);
}

/**
 * The live progress payload for a running job (Uber-style: steps, bar, time left). Null for jobs that are
 * not shown live. Time left is extrapolated from the elapsed time once a sixth of the work is done.
 */
export function liveRich(job: LiveJobRow, subject: { name: string; color: string } | null, now = new Date()): RichNotification | null {
  if (!isLiveJobType(job.type)) return null;
  const type = job.type;
  const progress = liveJobProgress(type, job.stage, job.status, job.progress);
  if (progress.state !== 'running') return null;
  const elapsed = job.started_at ? (now.getTime() - new Date(job.started_at).getTime()) / 1000 : 0;
  const eta = etaSeconds(progress.fraction, elapsed);
  const active = progress.steps.find((s) => s.state === 'active')?.label ?? progress.steps[0]!.label;
  const copy = LIVE_COPY[type];
  const link = job.type === 'ingest.document' && job.subject_id ? `studify://subjects/${job.subject_id}/processing` : undefined;
  return parseRichNotification({
    v: 1,
    key: liveKeyOf(job),
    template: 'progress',
    channel: 'live',
    title: copy.title,
    body: `${active}…`,
    ...(subject ? { sub: subject.name.slice(0, 60), accent: subject.color } : { accent: '#0369A1' }),
    glyph: copy.glyph,
    ...(link ? { deep_link: link } : {}),
    progress: { ...progress, ...(eta !== null && eta <= 7200 ? { eta_s: eta } : {}) },
  });
}

/**
 * The final notification of a material ("Material pronto" or the failure), keyed like its live progress so
 * it replaces the bar in place. Built by the worker (with the push) and by the app (when it sees the job
 * end first).
 */
export function materialDoneRich(input: {
  documentId: string;
  subjectId: string;
  subject: { name: string; color: string } | null;
  failed: boolean;
  /** ai_jobs.stage where a failed job stopped. */
  stage?: string | null;
  title?: string;
  body?: string;
}): RichNotification | null {
  const link = input.failed ? `studify://subjects/${input.subjectId}/document/${input.documentId}` : `studify://subjects/${input.subjectId}`;
  const progress = liveJobProgress('ingest.document', input.failed ? (input.stage ?? null) : 'done', input.failed ? 'failed' : 'succeeded', null);
  return parseRichNotification({
    v: 1,
    key: `doc:${input.documentId}`,
    template: 'progress',
    channel: 'processing',
    title: input.title ?? (input.failed ? 'Não consegui processar seu material' : 'Material pronto'),
    body: input.body ?? (input.failed ? 'Toque para ver o que aconteceu.' : `Seu material de ${input.subject?.name ?? 'estudo'} está pronto 📚`),
    glyph: input.failed ? 'alert' : 'book',
    ...(input.subject ? { sub: input.subject.name.slice(0, 60), accent: input.subject.color } : { accent: '#0369A1' }),
    deep_link: link,
    progress,
    actions: [{ id: 'open', label: input.failed ? 'Ver detalhes' : 'Estudar agora', kind: 'open', deep_link: link }],
  });
}
