// API payloads and jsonb shapes of Phase 5 (api.md §4.11): auto visuals, mnemonics, Dividir e conquistar,
// Perguntas da turma, the league board and the Retrospectiva stats.
import { z } from 'zod';
import { SourcePagesSchema } from '../citations.ts';
import { MNEMONIC_TYPE } from '../enums.ts';
import { UuidSchema } from './common.ts';

// ---------------------------------------------------------------- LRN-05 visuals

const VisualText = z.string().min(1).max(160);
const VisualDetail = z.string().max(400).nullable().optional();
const VisualNodeSchema = z.object({ id: z.string().min(1).max(40), label: VisualText, detail: VisualDetail, source_pages: SourcePagesSchema.optional() });

export const VisualSpecSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('flowchart'),
    nodes: z.array(VisualNodeSchema).min(2).max(12),
    edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(60).nullable().optional() })).min(1).max(30),
  }),
  z.object({ type: z.literal('cycle'), nodes: z.array(VisualNodeSchema).min(3).max(12) }),
  z.object({
    type: z.literal('timeline'),
    events: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          date_label: z.string().min(1).max(40),
          sort_key: z.number(),
          title: VisualText,
          detail: VisualDetail,
          source_pages: SourcePagesSchema.optional(),
        }),
      )
      .min(2)
      .max(15),
  }),
  z.object({
    type: z.literal('comparison_table'),
    columns: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(60) })).min(2).max(4),
    rows: z.array(z.object({ criterion: z.string().min(1).max(80), cells: z.array(z.string().max(200)), source_pages: SourcePagesSchema.optional() })).min(1).max(8),
  }),
  z.object({
    type: z.literal('hierarchy'),
    nodes: z.array(VisualNodeSchema.extend({ parent_id: z.string().nullable() })).min(2).max(20),
  }),
]);
export type VisualSpec = z.infer<typeof VisualSpecSchema>;

export const VISUAL_REQUEST_TYPES = ['flowchart', 'timeline', 'comparison_table', 'hierarchy', 'cycle'] as const;

export const VisualGenerateReqSchema = z.object({
  node_id: UuidSchema,
  /** Omitted = the AI picks the best type or says none fits (LRN-05.2). */
  type: z.enum(VISUAL_REQUEST_TYPES).optional(),
});
export type VisualGenerateReq = z.infer<typeof VisualGenerateReqSchema>;

export const VisualRowSchema = z.object({
  id: UuidSchema,
  node_id: UuidSchema,
  type: z.enum(VISUAL_REQUEST_TYPES),
  title: z.string(),
  spec: VisualSpecSchema,
  alt_text: z.string(),
  source_pages: SourcePagesSchema,
});
export type VisualRow = z.infer<typeof VisualRowSchema>;

export const VisualGenerateResSchema = z.discriminatedUnion('fits', [
  z.object({ fits: z.literal(true), visual: VisualRowSchema, cached: z.boolean() }),
  z.object({ fits: z.literal(false), reason: z.string() }),
]);
export type VisualGenerateRes = z.infer<typeof VisualGenerateResSchema>;

// ---------------------------------------------------------------- MEM-06 mnemonics

/** mnemonics.content (MEM-06): the text shown on the card back, plus the list it encodes and palace placements. */
export const MnemonicContentSchema = z.object({
  text: z.string().min(1).max(1200),
  items: z.array(z.string().min(1).max(120)).max(20).optional(),
  how_to_use: z.string().max(300).optional(),
  loci: z.array(z.object({ locus: z.string().min(1).max(60), item: z.string().min(1).max(120), image: z.string().max(300) })).max(20).optional(),
});
export type MnemonicContent = z.infer<typeof MnemonicContentSchema>;

export const MnemonicOptionSchema = z.object({
  type: z.enum(MNEMONIC_TYPE),
  title: z.string().min(1).max(120),
  content: MnemonicContentSchema,
});
export type MnemonicOption = z.infer<typeof MnemonicOptionSchema>;

export const MnemonicSuggestReqSchema = z
  .object({
    card_id: UuidSchema.optional(),
    node_id: UuidSchema.optional(),
    type: z.union([z.enum(MNEMONIC_TYPE), z.literal('any')]).default('any'),
    palace_id: UuidSchema.optional(),
    /** A list from a note (MEM-06.1 "as 7 etapas da mitose"), in order. */
    items: z.array(z.string().min(1).max(120)).min(2).max(20).optional(),
    /** "Outras ideias": titles already shown, so the next round differs (MEM-06.3). */
    exclude_titles: z.array(z.string().max(120)).max(12).optional(),
  })
  .refine((r) => r.card_id !== undefined || r.node_id !== undefined, { message: 'card_id or node_id is required', path: ['card_id'] })
  .refine((r) => (r.type === 'palace' ? r.palace_id !== undefined : true), { message: 'palace_id is required for a palace', path: ['palace_id'] });
export type MnemonicSuggestReq = z.infer<typeof MnemonicSuggestReqSchema>;

export const MnemonicSuggestResSchema = z.object({ options: z.array(MnemonicOptionSchema).min(1).max(3) });
export type MnemonicSuggestRes = z.infer<typeof MnemonicSuggestResSchema>;

// ---------------------------------------------------------------- SOC-06 Dividir e conquistar

/** contributions.ai_feedback (SOC-06.3), private to the author. */
export const ContributionFeedbackSchema = z.object({
  errors: z.array(z.object({ quote: z.string(), correction: z.string(), page: z.int().min(1).nullable(), document_id: UuidSchema.nullable() })),
  missing_concepts: z.array(z.string()),
  ok_to_merge: z.boolean(),
  summary: z.string(),
});
export type ContributionFeedback = z.infer<typeof ContributionFeedbackSchema>;

export const ContributionReviewReqSchema = z.object({ contribution_id: UuidSchema });
export const ContributionReviewResSchema = z.object({ feedback: ContributionFeedbackSchema });

export const ContributionSubmitReqSchema = z.object({ contribution_id: UuidSchema });
export const ContributionSubmitResSchema = z.object({ status: z.enum(['submitted', 'approved']), merge_started: z.boolean() });

export const DivideMergeReqSchema = z.object({ divide_plan_id: UuidSchema });
export const DivideMergeResSchema = z.object({ job_id: UuidSchema.nullable(), status: z.enum(['merging', 'done']) });

// ---------------------------------------------------------------- SOC-07 Perguntas da turma

export const PEER_QUESTION_TYPES = ['mcq_single', 'true_false', 'short_answer'] as const;
/** SOC-07.1 limit per author and day. */
export const PEER_QUESTIONS_PER_DAY = 20;
/** SOC-07.3: 👍 needed from other members. */
export const PEER_APPROVAL_VOTES = 3;
/** SOC-07.5: peer questions join class insights from this many answerers. */
export const PEER_INSIGHT_MIN_ANSWERERS = 10;

export const PeerValidationSchema = z.object({
  grounded: z.boolean(),
  evidence_pages: z.array(z.object({ document_id: UuidSchema, page: z.int().min(1) })),
  single_correct_answer: z.boolean(),
  clarity_issues: z.array(z.string()),
  appropriate: z.boolean(),
  duplicate_of: UuidSchema.nullable(),
  suggested_fix: z.object({ stem: z.string(), payload: z.record(z.string(), z.unknown()), explanation: z.string().nullable() }).nullable(),
});
export type PeerValidation = z.infer<typeof PeerValidationSchema>;

export const PeerQuestionCreateReqSchema = z.object({
  subject_id: UuidSchema,
  node_id: UuidSchema,
  type: z.enum(PEER_QUESTION_TYPES),
  stem: z.string().min(5).max(2000),
  payload: z.record(z.string(), z.unknown()),
  explanation: z.string().max(2000).optional(),
  anonymous: z.boolean().default(false),
  /** true = only check (SOC-07.2 suggestions), nothing is stored. */
  dry_run: z.boolean().default(false),
});
export type PeerQuestionCreateReq = z.infer<typeof PeerQuestionCreateReqSchema>;

export const PeerQuestionCreateResSchema = z.object({
  status: z.enum(['pending', 'needs_changes', 'ok']),
  question_id: UuidSchema.nullable(),
  validation: PeerValidationSchema,
  /** Why it cannot enter the pool yet (needs_changes). */
  blocking: z.array(z.enum(['not_grounded', 'not_single_answer', 'inappropriate', 'duplicate'])),
});
export type PeerQuestionCreateRes = z.infer<typeof PeerQuestionCreateResSchema>;

// ---------------------------------------------------------------- SOC-08 league board (RPC league_board)

export const LeagueBoardRowSchema = z.object({
  user_id: UuidSchema,
  nickname: z.string(),
  league_xp: z.int(),
  rank: z.int(),
  badges: z.array(z.string()),
  is_me: z.boolean(),
});
export type LeagueBoardRow = z.infer<typeof LeagueBoardRowSchema>;

// ---------------------------------------------------------------- MOT-04 Retrospectiva

export const RetroStatsSchema = z.object({
  period: z.enum(['goal', 'semester', 'year']),
  active_minutes: z.int().min(0),
  days_studied: z.int().min(0),
  cards_reviewed: z.int().min(0),
  questions_answered: z.int().min(0),
  accuracy: z.number().min(0).max(1).nullable(),
  best_subject: z.object({ name: z.string(), accuracy: z.number() }).nullable(),
  most_improved_topic: z.object({ title: z.string(), from: z.number(), to: z.number() }).nullable(),
  longest_streak: z.int().min(0),
  best_lucas_score: z.int().nullable(),
  duels_won: z.int().min(0),
  calibration_gain: z.number().nullable(),
  grades: z.array(z.object({ subject: z.string(), grade: z.string() })),
});
export type RetroStatsJson = z.infer<typeof RetroStatsSchema>;
