import { z } from 'zod';
import { ConceptKey, Confidence, Difficulty, DocPageRef, LanguageTag, MistakeCause, NodeKey, RemediationCard, SourcePages } from './common.ts';

// Phase 3 output schemas: Câmera Mágica (spec 11 §7), essay-question grading (PRA-07), Ache o Erro (PRA-06),
// problem sets and first wrong step (PRA-08), Podcast Interativo (INT-01) and Ensine o Lucas (INT-02).

const OptionalPages = z.array(DocPageRef).max(12);

// ---------------------------------------------------------------------------
// camera.understand — Step A (spec 11 §7.1)
// ---------------------------------------------------------------------------

export const CaptureUnderstanding = z.strictObject({
  content_type: z.enum(['book_page', 'whiteboard', 'handwritten_notes', 'exercise', 'essay', 'other']),
  language: LanguageTag,
  is_study_content: z.boolean(),
  contains_people: z.boolean(),
  /** Line breaks preserved; unreadable spans marked ⟦?⟧; annotations as "> anotação:" (spec 11 §9). */
  transcription_md: z.string().max(12_000),
  key_concepts: z.array(z.string().min(1).max(80)).max(8),
  /** Subject keys (S1, S2…) of the list sent in the prompt, never ids. */
  subject_guess: z.strictObject({ subject_key: z.string().regex(/^S\d{1,2}$/).nullable(), confidence: Confidence }),
  detected_questions: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(20),
        preview: z.string().min(1).max(160),
        text_md: z.string().min(1).max(4000),
        complete: z.boolean(),
        has_figure: z.boolean(),
      }),
    )
    .max(10),
  quality_issues: z
    .array(z.strictObject({ type: z.enum(['blur', 'glare', 'cutoff', 'dark', 'handwriting', 'other']), region_hint: z.string().max(80) }))
    .max(6),
});

// ---------------------------------------------------------------------------
// camera.solveLadder — CAM-02.4 hint ladder (spec 11 §7.2, §8.3)
// ---------------------------------------------------------------------------

export const HintLadder = z
  .strictObject({
    question_md: z.string().min(1).max(4000),
    trivial: z.boolean(),
    quantitative: z.boolean(),
    hints: z.array(z.strictObject({ level: z.number().int().min(1).max(4), text_md: z.string().min(1).max(1500) })).min(2).max(4),
    final_answer: z.string().min(1).max(300),
    answer_format: z.enum(['numeric', 'expression', 'choice', 'text']),
    why_others_wrong: z.array(z.strictObject({ option: z.string().min(1).max(4), reason: z.string().min(1).max(300) })).max(5),
    assumptions: z.array(z.string().min(1).max(200)).max(4),
    /** CAM-02.6: step the code check could not confirm ("Confira este cálculo"). */
    uncertain_step: z.number().int().min(1).max(4).nullable(),
    source_pages: OptionalPages,
  })
  .superRefine((v, ctx) => {
    const levels = v.hints.map((h) => h.level);
    if (!levels.every((l, i) => l === i + 1)) ctx.addIssue({ code: 'custom', message: 'níveis das dicas devem ser 1, 2, 3…', path: ['hints'] });
    if (!v.trivial && v.hints.length !== 4) ctx.addIssue({ code: 'custom', message: 'questão não trivial tem 4 níveis', path: ['hints'] });
    if (v.trivial && v.hints.length !== 2) ctx.addIssue({ code: 'custom', message: 'questão trivial tem 2 níveis', path: ['hints'] });
  });

// ---------------------------------------------------------------------------
// camera.transcribe — CAM-03 faithful transcription (spec 11 §7.3)
// ---------------------------------------------------------------------------

export const FaithfulTranscription = z
  .strictObject({
    lines: z.array(z.strictObject({ n: z.number().int().min(1), text: z.string().max(400) })).min(1).max(120),
    uncertain: z
      .array(z.strictObject({ line: z.number().int().min(1), word: z.string().min(1).max(60), alternatives: z.array(z.string().min(1).max(60)).max(2) }))
      .max(60),
    illegible_count: z.number().int().min(0),
    line_count_estimate: z.number().int().min(0).max(200),
    title_present: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.lines.every((l, i) => l.n === i + 1)) ctx.addIssue({ code: 'custom', message: 'linhas devem ser numeradas em ordem a partir de 1', path: ['lines'] });
  });

// ---------------------------------------------------------------------------
// grade.essayQuestion — PRA-07.5
// ---------------------------------------------------------------------------

export const EssayQuestionGrade = z.strictObject({
  built_rubric: z.boolean(),
  criteria: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(8),
        criterion: z.string().min(1).max(200),
        points_max: z.number().positive().max(100),
        points: z.number().min(0).max(100),
        verdict: z.enum(['full', 'partial', 'none']),
        justification: z.string().min(1).max(400),
      }),
    )
    .min(1)
    .max(10),
  strengths: z.array(z.string().min(1).max(200)).max(5),
  missing: z.array(z.strictObject({ point: z.string().min(1).max(200), source_pages: OptionalPages })).max(6),
  model_answer: z.string().min(1).max(3000),
  misconceptions: z.array(z.string().min(1).max(200)).max(4),
  suggested_cause: MistakeCause.nullable(),
  grader_confidence: z.enum(['low', 'medium', 'high']),
  feedback: z.string().min(1).max(800),
  remediation_card: RemediationCard.nullable(),
});

// ---------------------------------------------------------------------------
// acheOErro.generate — PRA-06
// ---------------------------------------------------------------------------

export const FIND_ERROR_TYPE_KEYS = ['conceitual', 'calculo', 'sinal', 'unidade', 'definicao', 'data_nome', 'causa_efeito'] as const;

const SegmentId = z.string().regex(/^S\d{1,2}$/, 'segmento S1, S2…');

export const AcheOErroItem = z
  .strictObject({
    statement_kind: z.enum(['statement', 'paragraph', 'solution']),
    segments: z.array(z.strictObject({ id: SegmentId, text: z.string().min(1).max(400) })).min(3).max(8),
    error_segment_id: SegmentId.nullable(),
    error_type: z.enum(FIND_ERROR_TYPE_KEYS).nullable(),
    explanation: z.string().min(1).max(600),
    corrected_text: z.string().min(1).max(400).nullable(),
    concept_keys: z.array(ConceptKey).min(1).max(3),
    difficulty: Difficulty,
    source_pages: SourcePages,
  })
  .superRefine((v, ctx) => {
    const ids = v.segments.map((s) => s.id);
    if (!ids.every((id, i) => id === `S${i + 1}`)) ctx.addIssue({ code: 'custom', message: 'segmentos devem ser S1, S2… em ordem', path: ['segments'] });
    if (v.error_segment_id !== null && !ids.includes(v.error_segment_id)) ctx.addIssue({ code: 'custom', message: 'error_segment_id fora dos segmentos', path: ['error_segment_id'] });
    const hasError = v.error_segment_id !== null;
    if (hasError !== (v.error_type !== null) || hasError !== (v.corrected_text !== null)) {
      ctx.addIssue({ code: 'custom', message: 'item sem erro não tem error_type nem corrected_text; item com erro tem os dois', path: ['error_type'] });
    }
  });

export const AcheOErroItems = z
  .strictObject({ items: z.array(AcheOErroItem).min(3).max(6) })
  .superRefine((v, ctx) => {
    const noError = v.items.filter((i) => i.error_segment_id === null).length;
    if (noError > 1) ctx.addIssue({ code: 'custom', message: 'no máximo um item sem erro', path: ['items'] });
  });

// ---------------------------------------------------------------------------
// problems.generate and problems.firstWrongStep — PRA-08
// ---------------------------------------------------------------------------

export const WorkedExample = z.strictObject({
  statement: z.string().min(1).max(1500),
  steps: z.array(z.string().min(1).max(400)).min(2).max(10),
  answer: z.string().min(1).max(200),
});

export const GeneratedProblem = z.strictObject({
  statement: z.string().min(1).max(2000),
  given: z.array(z.strictObject({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/), value: z.string().min(1).max(40) })).max(10),
  final_answer: z.string().min(1).max(200),
  answer_format: z.enum(['numeric', 'expression', 'choice']),
  unit: z.string().min(1).max(20).nullable(),
  tolerance: z.number().min(0).nullable(),
  check_expression: z.string().min(1).max(300).nullable(),
  solution_steps: z.array(z.string().min(1).max(400)).min(1).max(12),
  hints: z.array(z.string().min(1).max(200)).length(3),
  difficulty: Difficulty,
  concept_keys: z.array(ConceptKey).min(1).max(3),
  source_pages: SourcePages,
});

// No ordering rule here: writeProblems sorts by difficulty, so an out-of-order set is still usable.
export const ProblemSet = z.strictObject({
  worked_examples: z.array(WorkedExample).max(3),
  problems: z.array(GeneratedProblem).min(3).max(10),
});

export const FirstWrongStep = z.strictObject({
  student_steps: z.array(z.string().min(1).max(400)).max(20),
  first_wrong_step_index: z.number().int().min(0).nullable(),
  what_went_wrong: z.string().min(1).max(400),
  nudge: z.string().min(1).max(300),
});

// ---------------------------------------------------------------------------
// podcast.script — INT-01 (spec 12 §7.1)
// ---------------------------------------------------------------------------

export const PodcastScriptSchema = z
  .strictObject({
    title: z.string().min(1).max(160),
    segments: z
      .array(
        z.strictObject({
          id: z.string().regex(/^seg\d{1,2}$/),
          kind: z.enum(['hook', 'agenda', 'topic', 'recap', 'quickfire', 'outro']),
          node_keys: z.array(NodeKey).max(6),
          title: z.string().min(1).max(120),
          lines: z
            .array(
              z.strictObject({
                speaker: z.enum(['bia', 'caio']),
                text: z.string().min(1).max(600),
                pause_after_ms: z.number().int().min(0).max(6000).nullable(),
              }),
            )
            .min(1)
            .max(80),
          source_pages: OptionalPages,
          recall_question: z.strictObject({ question: z.string().min(1).max(300), answer: z.string().min(1).max(300) }).nullable(),
        }),
      )
      .min(3)
      .max(20),
  })
  .superRefine((v, ctx) => {
    const ids = v.segments.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'ids de segmento repetidos', path: ['segments'] });
  });

// ---------------------------------------------------------------------------
// lucas.plan and lucas.turn — INT-02 (spec 12 §7.2, §7.3)
// ---------------------------------------------------------------------------

export const LucasPlanSchema = z
  .strictObject({
    key_concepts: z
      .array(z.strictObject({ id: z.string().regex(/^k\d$/), statement: z.string().min(1).max(300), concept_key: ConceptKey.nullable(), source_pages: SourcePages }))
      .min(2)
      .max(6),
    misconceptions: z
      .array(
        z.strictObject({
          id: z.string().regex(/^m\d$/),
          lucas_belief: z.string().min(1).max(300),
          correct_concept: z.string().min(1).max(300),
          fix_criteria: z.array(z.string().min(1).max(200)).min(1).max(4),
          trigger: z.enum(['early', 'mid', 'late']),
          source_pages: SourcePages,
        }),
      )
      .max(5),
    naive_questions: z.array(z.string().min(1).max(200)).min(2).max(6),
  })
  .superRefine((v, ctx) => {
    const ids = [...v.key_concepts.map((k) => k.id), ...v.misconceptions.map((m) => m.id)];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'ids repetidos no plano', path: ['key_concepts'] });
  });

export const LucasTurnSchema = z.strictObject({
  /** First field: the app renders it while the rest of the JSON arrives (spec 12 §7.3). */
  lucas_reply: z.string().min(1).max(600),
  safety: z.enum(['ok', 'distress', 'off_topic', 'inappropriate']),
  evaluation: z.strictObject({
    misconception_updates: z
      .array(z.strictObject({ id: z.string().regex(/^m\d$/), status: z.enum(['hidden', 'revealed', 'partially_fixed', 'fixed']) }))
      .max(5),
    concepts_covered: z.array(z.strictObject({ id: z.string().regex(/^k\d$/), quality: z.enum(['correct', 'partial', 'wrong']) })).max(6),
    errors_taught: z
      .array(
        z.strictObject({
          claim: z.string().min(1).max(300),
          correction: z.string().min(1).max(300),
          severity: z.enum(['minor', 'major']),
          concept_id: z.string().regex(/^k\d$/).nullable(),
          source_pages: OptionalPages,
        }),
      )
      .max(4),
    clarity_signals: z.strictObject({ used_example: z.boolean(), used_analogy: z.boolean(), checked_understanding: z.boolean() }),
  }),
});
