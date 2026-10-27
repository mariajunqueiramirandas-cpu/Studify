// API payloads and jsonb shapes of Phase 4 (api.md §4.9 ENEM, §4.10 admin, §4.8 argument-*): Simulado com TRI,
// Correção de Redação results, Meta SISU targets, theme generation and Treino de Argumentação.
import { z } from 'zod';
import { ARGUMENT_GOAL_MODE, ARGUMENT_MODE, ARGUMENT_THEME_SOURCE, ENEM_APPLICATION, ENEM_AREA, ENEM_LANGUAGE } from '../enums.ts';
import { UuidSchema } from './common.ts';

const ScoreAreaSchema = z.enum(['LC', 'CH', 'CN', 'MT', 'RED']);
const SisuNumbersSchema = z.object({ LC: z.number(), CH: z.number(), CN: z.number(), MT: z.number(), RED: z.number() });

// ---------------------------------------------------------------- Simulado com TRI (ENM-04)

export const ENEM_SIMULADO_API_MODES = ['full_day1', 'full_day2', 'area', 'mini'] as const;

export const EnemSimuladoCreateReqSchema = z
  .object({
    goal_id: UuidSchema,
    mode: z.enum(ENEM_SIMULADO_API_MODES),
    area: z.enum(ENEM_AREA).optional(),
    mini_size: z.union([z.literal(15), z.literal(30)]).optional(),
    source: z.enum(['replica', 'misto', 'provavel']),
    edition: z.int().min(2009).max(2100).optional(),
    language: z.enum(ENEM_LANGUAGE),
    includes_essay: z.boolean().optional(),
  })
  .refine((r) => (r.mode === 'area' || r.mode === 'mini' ? r.area !== undefined : true), { message: 'area is required for area/mini', path: ['area'] })
  .refine((r) => (r.source === 'replica' ? r.edition !== undefined : true), { message: 'edition is required for a réplica', path: ['edition'] });
export type EnemSimuladoCreateReq = z.infer<typeof EnemSimuladoCreateReqSchema>;

export const EnemSimuladoCreateResSchema = z.object({
  quiz_id: UuidSchema,
  attempt_id: UuidSchema,
  time_limit_min: z.int().positive(),
  item_count: z.int().positive(),
  /** Areas whose pool could not fill the quota (items missing). */
  shortfall: z.record(z.string(), z.int()).optional(),
});
export type EnemSimuladoCreateRes = z.infer<typeof EnemSimuladoCreateResSchema>;

/** quizzes.config of an `enem_simulado` (spec 09 §6.2). */
export const EnemSimuladoConfigSchema = z.object({
  mode: z.enum(ENEM_SIMULADO_API_MODES),
  area: z.enum(ENEM_AREA).optional(),
  source: z.enum(['replica', 'misto', 'provavel']),
  edition: z.int().optional(),
  language: z.enum(ENEM_LANGUAGE),
  item_ids: z.array(UuidSchema),
  time_limit_min: z.int().positive(),
  includes_essay: z.boolean(),
  seed: z.string(),
  predicted: z.boolean().optional(),
  goal_id: UuidSchema.optional(),
});
export type EnemSimuladoConfig = z.infer<typeof EnemSimuladoConfigSchema>;

export const EnemAreaResultSchema = z.object({
  theta: z.number(),
  se: z.number(),
  score: z.number(),
  ci80_low: z.number(),
  ci80_high: z.number(),
  n_items: z.int(),
  n_correct: z.int(),
  n_blank: z.int(),
  coherence: z.object({
    lz: z.number().nullable(),
    level: z.enum(['alta', 'media', 'baixa']).nullable(),
    easy_miss_ids: z.array(z.string()),
    lucky_hit_ids: z.array(z.string()),
  }),
  time: z.object({
    total_s: z.number(),
    per_item_s: z.array(z.number()),
    stuck_ids: z.array(z.string()),
    target_s: z.number().optional(),
    blocks: z.array(z.object({ from: z.int(), to: z.int(), n: z.int(), correct: z.int(), accuracy: z.number() })).optional(),
  }),
});
export type EnemAreaResult = z.infer<typeof EnemAreaResultSchema>;

/** quiz_attempts.area_results of an ENEM simulado: one entry per scored area, plus the paused flag. */
export const EnemAreaResultsSchema = z.object({
  areas: z.partialRecord(z.enum(ENEM_AREA), EnemAreaResultSchema),
  paused: z.boolean().optional(),
  /** The Meta SISU estimate when the attempt covers every area of the target (ENM-04.8). */
  sisu: z.number().nullable().optional(),
});
export type EnemAreaResults = z.infer<typeof EnemAreaResultsSchema>;

// ---------------------------------------------------------------- Correção de Redação (ENM-05)

export const RedacaoEvidenceSchema = z.object({ quote: z.string(), line: z.int().min(0).nullable() });

export const RedacaoCompetenciaSchema = z.object({
  id: z.int().min(1).max(5),
  score: z.int().min(0).max(200),
  level_text: z.string(),
  justification: z.string(),
  evidence: z.array(RedacaoEvidenceSchema),
  issues: z.array(z.object({ type: z.string(), quote: z.string(), line: z.int().min(0).nullable(), fix: z.string() })),
  strengths: z.array(z.string()),
});
export type RedacaoCompetencia = z.infer<typeof RedacaoCompetenciaSchema>;

/** essays.competencias for an ENEM redação: `{c1..c5}` keyed by competência. */
export const EssayCompetenciasSchema = z.record(z.string(), RedacaoCompetenciaSchema);

export const PropostaCheckSchema = z.object({
  agente: z.object({ present: z.boolean(), quote: z.string().nullable() }),
  acao: z.object({ present: z.boolean(), quote: z.string().nullable() }),
  meio: z.object({ present: z.boolean(), quote: z.string().nullable() }),
  finalidade: z.object({ present: z.boolean(), quote: z.string().nullable() }),
  detalhamento: z.object({ present: z.boolean(), quote: z.string().nullable() }),
  direitos_humanos_ok: z.boolean(),
  note: z.string().nullable(),
});
export type PropostaCheck = z.infer<typeof PropostaCheckSchema>;

export const REPERTORIO_CHECK_STATUS = ['confirmed', 'not_found', 'contradicted', 'unverified'] as const;

export const RepertorioCheckSchema = z.object({
  text: z.string(),
  kind: z.enum(['quote', 'data', 'law', 'work', 'event']),
  line: z.int().min(0).nullable(),
  status: z.enum(REPERTORIO_CHECK_STATUS),
  source_url: z.string().nullable(),
  source_name: z.string().nullable(),
  note: z.string().nullable(),
});
export type RepertorioCheck = z.infer<typeof RepertorioCheckSchema>;

export const RedacaoRewriteSchema = z.object({ paragraph: z.int().min(1), original: z.string(), suggested: z.string(), why: z.string() });

// ---------------------------------------------------------------- Theme generator (ENM-05.8)

export const EssayThemeGenerateReqSchema = z
  .object({
    source: z.enum(['predicted', 'past_enem', 'atualidades', 'custom']),
    axis: z.string().min(1).max(80).optional(),
    title: z.string().min(5).max(300).optional(),
    /** Atualidades: the digest item the theme comes from. */
    atualidades_item_id: UuidSchema.optional(),
  })
  .refine((r) => (r.source === 'custom' ? r.title !== undefined : true), { message: 'title is required for a custom theme', path: ['title'] });
export type EssayThemeGenerateReq = z.infer<typeof EssayThemeGenerateReqSchema>;

export const EssayThemeGenerateResSchema = z.object({ theme_id: UuidSchema, title: z.string(), source: z.string() });
export type EssayThemeGenerateRes = z.infer<typeof EssayThemeGenerateResSchema>;

/** essay_themes.prompt: instruction + motivating texts with sources. */
export const EssayThemePromptSchema = z.object({
  instruction: z.string(),
  motivating_texts: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(['summary', 'data', 'excerpt']).optional(),
      text_md: z.string(),
      source_name: z.string().nullable(),
      source_url: z.string().nullable(),
      published_at: z.string().nullable().optional(),
    }),
  ),
});
export type EssayThemePrompt = z.infer<typeof EssayThemePromptSchema>;

// ---------------------------------------------------------------- Meta SISU (ENM-06)

export const SisuManualSchema = z.object({
  label: z.string().min(1).max(120),
  weights: SisuNumbersSchema,
  min_scores: SisuNumbersSchema.partial().optional(),
});
export type SisuManual = z.infer<typeof SisuManualSchema>;

/** sisu_targets.targets: the computed per-area targets and the numbers behind them. */
export const SisuTargetsJsonSchema = z.object({
  status: z.enum(['above', 'ok', 'impossible', 'missing_estimates']),
  estimates: SisuNumbersSchema.partial(),
  current: z.number().nullable(),
  required: z.number(),
  gap: z.number().nullable(),
  targets: SisuNumbersSchema.nullable(),
  display: SisuNumbersSchema.nullable(),
  missing: z.array(ScoreAreaSchema),
});
export type SisuTargetsJson = z.infer<typeof SisuTargetsJsonSchema>;

// ---------------------------------------------------------------- Treino de Argumentação (INT-03)

export const ArgumentStartReqSchema = z
  .object({
    goal_mode: z.enum(ARGUMENT_GOAL_MODE),
    theme: z.string().min(5).max(300).optional(),
    theme_id: UuidSchema.optional(),
    theme_source: z.enum(ARGUMENT_THEME_SOURCE),
    mode: z.enum(ARGUMENT_MODE),
    subject_id: UuidSchema.optional(),
    /** School mode: the topic whose material the opponent may cite (a suggested theme's first node). */
    node_id: UuidSchema.optional(),
    round_limit: z.int().min(3).max(5).optional(),
  })
  .refine((r) => r.theme !== undefined || r.theme_id !== undefined, { message: 'theme or theme_id is required', path: ['theme'] });
export type ArgumentStartReq = z.infer<typeof ArgumentStartReqSchema>;

export const ArgumentStartResSchema = z.object({ session_id: UuidSchema, theme: z.string(), opening: z.string() });
export type ArgumentStartRes = z.infer<typeof ArgumentStartResSchema>;

export const ArgumentTurnReqSchema = z.object({ session_id: UuidSchema, message: z.string().min(1).max(3000) });
export type ArgumentTurnReq = z.infer<typeof ArgumentTurnReqSchema>;

export const ArgumentCriteriaSchema = z.object({
  tese: z.int().min(0).max(4),
  fundamentacao: z.int().min(0).max(4),
  repertorio: z.int().min(0).max(4),
  coerencia: z.int().min(0).max(4),
  refutacao: z.int().min(0).max(4),
  falacias: z.int().min(0).max(4),
});
export type ArgumentCriteria = z.infer<typeof ArgumentCriteriaSchema>;

/** One round as stored in argument_sessions.rounds and shown in the app. */
export const ArgumentRoundSchema = z.object({
  user_text: z.string(),
  opponent_text: z.string(),
  feedback: z.object({
    rubric: ArgumentCriteriaSchema,
    fallacies: z.array(z.object({ name: z.string(), quote: z.string(), explanation: z.string() })),
    tip: z.string(),
  }),
  citations: z.array(z.unknown()).optional(),
  at: z.string(),
});
export type ArgumentRound = z.infer<typeof ArgumentRoundSchema>;

/** done.result of argument-turn: the thesis step, or a round. */
export const ArgumentTurnResultSchema = z.discriminatedUnion('stage', [
  z.object({
    stage: z.literal('thesis'),
    thesis_feedback: z.object({ clear: z.boolean(), has_position: z.boolean(), specific: z.boolean(), feedback: z.string(), suggestion: z.string().nullable() }),
  }),
  z.object({ stage: z.literal('round'), round: z.int().min(1), round_limit: z.int().min(1), final: z.boolean(), feedback: ArgumentRoundSchema.shape.feedback }),
]);
export type ArgumentTurnResult = z.infer<typeof ArgumentTurnResultSchema>;

export const ArgumentFinishReqSchema = z.object({ session_id: UuidSchema, create_essay: z.boolean().optional() });
export type ArgumentFinishReq = z.infer<typeof ArgumentFinishReqSchema>;

const OutlineArgumentSchema = z.object({ topico: z.string(), argumento: z.string(), repertorio: z.string().nullable() });
export const EssayOutlineSchema = z.object({
  introducao: z.object({ contexto: z.string(), tese: z.string() }),
  d1: OutlineArgumentSchema,
  d2: OutlineArgumentSchema,
  conclusao: z.object({
    retomada: z.string(),
    proposta: z.object({ agente: z.string(), acao: z.string(), meio: z.string(), finalidade: z.string(), detalhamento: z.string() }),
  }),
});
export type EssayOutline = z.infer<typeof EssayOutlineSchema>;

export const ArgumentFinishResSchema = z.object({
  /** Overall 0–4 per criterion and the total in % (Σ / 24). */
  rubric: ArgumentCriteriaSchema.extend({ total: z.int().min(0).max(100) }),
  summary: z.object({
    strongest_argument: z.string().nullable(),
    weakest_point: z.string().nullable(),
    fallacies: z.array(z.object({ name: z.string(), count: z.int() })),
    repertorio_suggestions: z.array(z.object({ text: z.string(), origin: z.enum(['material', 'geral']) })),
    strengths: z.array(z.string()),
    improve: z.array(z.string()),
  }),
  outline: EssayOutlineSchema.nullable(),
  essay_id: UuidSchema.nullable(),
});
export type ArgumentFinishRes = z.infer<typeof ArgumentFinishResSchema>;

export const ArgumentThemesReqSchema = z.object({ subject_id: UuidSchema });
export const ArgumentThemesResSchema = z.object({
  themes: z.array(z.object({ question: z.string(), node_ids: z.array(UuidSchema), why: z.string() })),
});
export type ArgumentThemesRes = z.infer<typeof ArgumentThemesResSchema>;

// ---------------------------------------------------------------- Admin (§4.10)

export const AdminEnemImportReqSchema = z.object({ year: z.int().min(2009).max(2100), application: z.enum(ENEM_APPLICATION).default('regular') });
export type AdminEnemImportReq = z.infer<typeof AdminEnemImportReqSchema>;

export const AdminAtualidadesPublishReqSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish'), digest_id: UuidSchema }),
  z.object({ action: z.literal('withdraw'), digest_id: UuidSchema }),
  z.object({ action: z.literal('withdraw_item'), item_id: UuidSchema }),
]);
export type AdminAtualidadesPublishReq = z.infer<typeof AdminAtualidadesPublishReqSchema>;
