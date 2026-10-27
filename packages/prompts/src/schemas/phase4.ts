import { z } from 'zod';
import { Confidence, DocPageRef, NodeKey, SourcePages } from './common.ts';

// Phase 4 output schemas: ENEM mode (spec 09 §7), Prova Provável ENEM themes (spec 08 §7.4) and Treino de
// Argumentação (spec 12 §7.5). Totals, TRI and statistics are computed in code, never by the model.

const Letter = z.enum(['A', 'B', 'C', 'D', 'E']);
/** Web source URL; checked against the research call's citations in code. */
export const HttpUrl = z.string().min(8).max(600).regex(/^https?:\/\/\S+$/, 'URL http(s)');
const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export const EnemSkillCode = z.string().regex(/^(LC|CH|CN|MT)-H([1-9]|[12][0-9]|30)$/, 'código de habilidade, ex.: MT-H21');
/** Keys of the ENEM topic list sent in the prompt (T1, T2…), never ids. */
export const EnemTopicKey = z.string().regex(/^T\d{1,4}$/, 'chave de tópico ENEM, ex.: T12');

const Alternatives = z
  .array(z.strictObject({ label: Letter, text_md: z.string().min(1).max(1500) }))
  .length(5)
  .superRefine((alts, ctx) => {
    if (!alts.every((a, i) => a.label === LETTERS[i])) ctx.addIssue({ code: 'custom', message: 'alternativas devem ser A, B, C, D, E nessa ordem' });
  });

const DistractorRationales = z.array(z.strictObject({ label: Letter, why: z.string().min(1).max(600) })).length(4);

function distractorsCover(answer: string, rationales: ReadonlyArray<{ label: string }>, ctx: z.RefinementCtx, path: string): void {
  const labels = new Set(rationales.map((r) => r.label));
  if (labels.size !== 4 || labels.has(answer)) ctx.addIssue({ code: 'custom', message: 'uma justificativa para cada alternativa errada', path: [path] });
}

// ---------------------------------------------------------------------------
// enem.tagNodes — ENM-01.4 (spec 09 §7.1)
// ---------------------------------------------------------------------------

export const EnemNodeTags = z.strictObject({
  nodes: z
    .array(
      z.strictObject({
        node_key: NodeKey,
        skill_codes: z.array(z.strictObject({ code: EnemSkillCode, confidence: Confidence })).max(3),
        enem_topic_keys: z.array(z.strictObject({ key: EnemTopicKey, confidence: Confidence })).max(3),
      }),
    )
    .max(400),
});

// ---------------------------------------------------------------------------
// Bank import — ENM-02 (spec 09 §7.2–7.4)
// ---------------------------------------------------------------------------

export const EnemItemTranscription = z
  .strictObject({
    statement_md: z.string().min(1).max(8000),
    alternatives: Alternatives,
    has_figure: z.boolean(),
    alt_text: z.string().min(1).max(1200).nullable(),
    subject_guess: z.string().min(1).max(60).nullable(),
    /** Parts the model could not read: the item goes to review (ENM-02.9). */
    unreadable: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.has_figure && !v.alt_text) ctx.addIssue({ code: 'custom', message: 'figura exige texto alternativo', path: ['alt_text'] });
  });

export const EnemItemExplanation = z
  .strictObject({
    chosen_answer: Letter,
    solution_md: z.string().min(1).max(6000),
    distractors: z.array(z.strictObject({ label: Letter, why_wrong: z.string().min(1).max(600) })).length(4),
    skill_explanation: z.string().min(1).max(600),
  })
  .superRefine((v, ctx) => distractorsCover(v.chosen_answer, v.distractors, ctx, 'distractors'));

export const EnemItemTopics = z.strictObject({
  subject: z.string().min(1).max(60),
  enem_topic_keys: z.array(z.strictObject({ key: EnemTopicKey, confidence: Confidence })).min(1).max(3),
});

// ---------------------------------------------------------------------------
// enem.question.generate — ENM-03 (spec 09 §7.5)
// ---------------------------------------------------------------------------

export const ChartData = z.strictObject({
  type: z.enum(['bar', 'line', 'pie']),
  title: z.string().min(1).max(120),
  x_label: z.string().max(60).nullable(),
  y_label: z.string().max(60).nullable(),
  series: z
    .array(z.strictObject({ name: z.string().min(1).max(60), points: z.array(z.strictObject({ x: z.string().min(1).max(40), y: z.number() })).min(2).max(24) }))
    .min(1)
    .max(4),
});

export const TextoBase = z
  .strictObject({
    kind: z.enum(['excerpt', 'written', 'chart', 'table']),
    content_md: z.string().min(1).max(2000),
    chart_data: ChartData.nullable(),
    source_pages: z.array(DocPageRef).max(4),
    /** "Texto elaborado pelo Studify" for written texts (ENM-03.3). */
    label: z.string().max(120).nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'excerpt' && v.content_md.length > 600) ctx.addIssue({ code: 'custom', message: 'trecho do material com até 600 caracteres', path: ['content_md'] });
    if (v.kind === 'excerpt' && v.source_pages.length === 0) ctx.addIssue({ code: 'custom', message: 'trecho do material precisa da página', path: ['source_pages'] });
    if (v.kind === 'chart' && !v.chart_data) ctx.addIssue({ code: 'custom', message: 'gráfico precisa de chart_data', path: ['chart_data'] });
    if (v.kind === 'written' && v.label !== 'Texto elaborado pelo Studify') ctx.addIssue({ code: 'custom', message: 'texto escrito leva o rótulo "Texto elaborado pelo Studify"', path: ['label'] });
  });

export const EnemGeneratedItem = z
  .strictObject({
    texto_base: TextoBase,
    comando_md: z.string().min(1).max(800),
    alternatives: Alternatives,
    answer: Letter,
    explanation_md: z.string().min(1).max(3000),
    distractor_rationales: DistractorRationales,
    skill_code: EnemSkillCode,
    difficulty: z.enum(['facil', 'media', 'dificil']),
    source_pages: SourcePages,
  })
  .superRefine((v, ctx) => distractorsCover(v.answer, v.distractor_rationales, ctx, 'distractor_rationales'));

export const EnemGeneratedItems = z.strictObject({ items: z.array(EnemGeneratedItem).min(1).max(10) });

// ---------------------------------------------------------------------------
// essay.grade — ENM-05 (spec 09 §7.6, §8.6)
// ---------------------------------------------------------------------------

export const REDACAO_ZERO_REASON_KEYS = [
  'fuga_tema',
  'tipo_textual',
  'em_branco',
  'texto_insuficiente',
  'anulacao',
  'parte_desconectada',
  'identificacao',
  'lingua_estrangeira',
  'ilegivel',
] as const;

const GridScore = z.union([z.literal(0), z.literal(40), z.literal(80), z.literal(120), z.literal(160), z.literal(200)]);
const LineNo = z.number().int().min(1).max(60).nullable();
const PropostaElement = z.strictObject({ present: z.boolean(), quote: z.string().max(400).nullable() });

export const EssayGrade = z
  .strictObject({
    zero_check: z.strictObject({ is_zero: z.boolean(), reasons: z.array(z.enum(REDACAO_ZERO_REASON_KEYS)).max(4), evidence: z.string().max(600).nullable() }),
    competencias: z
      .array(
        z.strictObject({
          id: z.number().int().min(1).max(5),
          score: GridScore,
          level_text: z.string().min(1).max(400),
          justification: z.string().min(1).max(1200),
          evidence: z.array(z.strictObject({ quote: z.string().min(1).max(400), line: LineNo })).max(4),
          issues: z.array(z.strictObject({ type: z.string().min(1).max(40), quote: z.string().max(400), line: LineNo, fix: z.string().min(1).max(400) })).max(12),
          strengths: z.array(z.string().min(1).max(300)).max(4),
        }),
      )
      .length(5),
    proposta: z.strictObject({
      agente: PropostaElement,
      acao: PropostaElement,
      meio: PropostaElement,
      finalidade: PropostaElement,
      detalhamento: PropostaElement,
      direitos_humanos_ok: z.boolean(),
      note: z.string().max(600).nullable(),
    }),
    repertorio_refs: z.array(z.strictObject({ text: z.string().min(1).max(400), kind: z.enum(['quote', 'data', 'law', 'work', 'event']), line: LineNo })).max(10),
    rewrites: z.array(z.strictObject({ paragraph: z.number().int().min(1).max(8), original: z.string().min(1).max(2000), suggested: z.string().min(1).max(2000), why: z.string().min(1).max(600) })).max(2),
    top_actions: z.array(z.string().min(1).max(300)).length(3),
  })
  .superRefine((v, ctx) => {
    const ids = v.competencias.map((c) => c.id).sort();
    if (ids.join() !== '1,2,3,4,5') ctx.addIssue({ code: 'custom', message: 'uma nota para cada competência C1–C5', path: ['competencias'] });
    if (v.zero_check.is_zero !== v.zero_check.reasons.length > 0) ctx.addIssue({ code: 'custom', message: 'is_zero exige ao menos um motivo (e motivo exige is_zero)', path: ['zero_check'] });
  });

// ---------------------------------------------------------------------------
// repertorio.verify — ENM-05.5 (spec 09 §7.7), structuring step
// ---------------------------------------------------------------------------

export const RepertorioVerdict = z
  .strictObject({
    status: z.enum(['confirmed', 'not_found', 'contradicted']),
    source_url: HttpUrl.nullable(),
    source_name: z.string().min(1).max(120).nullable(),
    note: z.string().min(1).max(400),
  })
  .superRefine((v, ctx) => {
    if (v.status !== 'not_found' && !v.source_url) ctx.addIssue({ code: 'custom', message: 'confirmado/contradito exige a fonte', path: ['source_url'] });
  });

// ---------------------------------------------------------------------------
// atualidades.structure — ENM-09 (spec 09 §7.8)
// ---------------------------------------------------------------------------

export const WrittenEnemQuestion = z
  .strictObject({
    texto_base_md: z.string().min(1).max(1500),
    comando_md: z.string().min(1).max(800),
    alternatives: Alternatives,
    answer: Letter,
    explanation_md: z.string().min(1).max(2000),
    distractor_rationales: DistractorRationales,
    skill_code: EnemSkillCode,
    difficulty: z.enum(['facil', 'media', 'dificil']),
  })
  .superRefine((v, ctx) => distractorsCover(v.answer, v.distractor_rationales, ctx, 'distractor_rationales'));

const WebSource = z.strictObject({ url: HttpUrl, name: z.string().min(1).max(120), published_at: z.string().max(40).nullable() });

export const AtualidadesDigest = z.strictObject({
  items: z
    .array(
      z
        .strictObject({
          title: z.string().min(3).max(200),
          summary_md: z.string().min(1).max(1400),
          why_md: z.string().min(1).max(1000),
          areas: z.array(z.enum(['LC', 'CH', 'CN', 'MT', 'RED'])).min(1).max(5),
          skill_codes: z.array(EnemSkillCode).max(6),
          redacao_axes: z.array(z.string().min(1).max(80)).max(4),
          repertorio: z.array(z.strictObject({ text: z.string().min(1).max(400), source_url: HttpUrl })).max(5),
          sources: z.array(WebSource).min(1).max(6),
          questions: z.array(WrittenEnemQuestion).length(2),
        })
        .superRefine((v, ctx) => {
          const words = v.summary_md.trim().split(/\s+/).length;
          if (words > 150) ctx.addIssue({ code: 'custom', message: 'resumo com até 150 palavras', path: ['summary_md'] });
        }),
    )
    .max(8),
  /** Fewer than 3 suitable items: the week is skipped with this note (spec 09 §9). */
  skipped_note: z.string().max(400).nullable(),
});

// ---------------------------------------------------------------------------
// enem.themes.predict — ENM-08.6 (spec 08 §7.4) and essay.themePrompt — ENM-05.8
// ---------------------------------------------------------------------------

const MotivatingText = z.strictObject({
  kind: z.enum(['summary', 'data']),
  text: z.string().min(1).max(900),
  source_url: HttpUrl,
  source_name: z.string().min(1).max(120),
  published_at: z.string().max(40).nullable(),
});

export const PredictedThemes = z
  .strictObject({
    themes: z
      .array(
        z.strictObject({
          title: z.string().min(10).max(220),
          axis: z.string().min(1).max(80),
          rationale: z.string().min(1).max(700),
          connections: z.array(z.strictObject({ digest_item_key: z.string().regex(/^A\d{1,3}$/), why: z.string().min(1).max(300) })).max(5),
          repertorio_directions: z.array(z.string().min(1).max(200)).max(5),
          prompt: z.strictObject({ instruction: z.string().min(1).max(1200), motivating_texts: z.array(MotivatingText).min(2).max(4) }),
        }),
      )
      .min(8)
      .max(12),
  })
  .superRefine((v, ctx) => {
    const axes = new Set(v.themes.map((t) => t.axis.trim().toLowerCase()));
    if (axes.size < 5) ctx.addIssue({ code: 'custom', message: 'pelo menos 5 eixos sociais diferentes', path: ['themes'] });
  });

export const EssayThemePromptOut = z.strictObject({
  title: z.string().min(10).max(220),
  axis: z.string().min(1).max(80),
  instruction: z.string().min(1).max(1200),
  motivating_texts: z
    .array(
      z.strictObject({
        kind: z.enum(['summary', 'data', 'context']),
        text: z.string().min(1).max(900),
        /** Only URLs from the given sources; null for a context text written by Studify. */
        source_url: HttpUrl.nullable(),
        source_name: z.string().min(1).max(120).nullable(),
      }),
    )
    .min(1)
    .max(4),
});

// ---------------------------------------------------------------------------
// Treino de Argumentação — INT-03 (spec 12 §7.5, §8.7)
// ---------------------------------------------------------------------------

export const FALLACY_NAMES = [
  'generalização apressada',
  'ad hominem',
  'falso dilema',
  'apelo à emoção',
  'espantalho',
  'apelo à autoridade irrelevante',
  'ladeira escorregadia',
  'petição de princípio',
  'falsa causa',
] as const;

const Score04 = z.number().int().min(0).max(4);
export const ArgumentCriteria = z.strictObject({
  tese: Score04,
  fundamentacao: Score04,
  repertorio: Score04,
  coerencia: Score04,
  refutacao: Score04,
  falacias: Score04,
});

export const ArgumentRoundFeedback = z.strictObject({
  rubric: ArgumentCriteria,
  fallacies: z.array(z.strictObject({ name: z.enum(FALLACY_NAMES), quote: z.string().min(1).max(300), explanation: z.string().min(1).max(300) })).max(4),
  tip: z.string().min(1).max(300),
});

export const ThesisFeedback = z.strictObject({
  clear: z.boolean(),
  has_position: z.boolean(),
  specific: z.boolean(),
  feedback: z.string().min(1).max(400),
  suggestion: z.string().max(300).nullable(),
});

const OutlineArgument = z.strictObject({ topico: z.string().min(1).max(300), argumento: z.string().min(1).max(600), repertorio: z.string().max(300).nullable() });

export const ArgumentSummary = z.strictObject({
  rubric: ArgumentCriteria,
  strongest_argument: z.string().max(400).nullable(),
  weakest_point: z.string().max(400).nullable(),
  fallacies: z.array(z.strictObject({ name: z.enum(FALLACY_NAMES), count: z.number().int().min(1).max(20) })).max(9),
  repertorio_suggestions: z.array(z.strictObject({ text: z.string().min(1).max(300), origin: z.enum(['material', 'geral']) })).max(5),
  strengths: z.array(z.string().min(1).max(300)).max(4),
  improve: z.array(z.string().min(1).max(300)).max(4),
  /** ENEM only: Esqueleto de redação with the 5-element proposta (INT-03.7). */
  outline: z
    .strictObject({
      introducao: z.strictObject({ contexto: z.string().min(1).max(500), tese: z.string().min(1).max(400) }),
      d1: OutlineArgument,
      d2: OutlineArgument,
      conclusao: z.strictObject({
        retomada: z.string().min(1).max(400),
        proposta: z.strictObject({
          agente: z.string().min(1).max(200),
          acao: z.string().min(1).max(300),
          meio: z.string().min(1).max(300),
          finalidade: z.string().min(1).max(300),
          detalhamento: z.string().min(1).max(300),
        }),
      }),
    })
    .nullable(),
});

export const ArgumentThemes = z.strictObject({
  themes: z
    .array(z.strictObject({ question: z.string().min(10).max(200), node_keys: z.array(NodeKey).min(1).max(3), why: z.string().min(1).max(200) }))
    .length(5),
});
