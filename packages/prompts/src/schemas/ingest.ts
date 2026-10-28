import { z } from 'zod';
import { ConceptKey, Confidence, LanguageTag, NodeKey, PageNumber, pageRangeIssue } from './common.ts';

const Key = z.string().min(1).max(20);
const Title = z.string().min(1).max(80);
const Summary = z.string().min(1).max(240);

const TopicOut = z
  .strictObject({
    key: Key,
    title: Title,
    summary: Summary,
    learning_objectives: z.array(z.string().min(3).max(140)).min(1).max(5),
    page_start: PageNumber,
    page_end: PageNumber,
    match_existing_node_id: z.string().min(1).max(64).nullable(),
  })
  .superRefine((v, ctx) => {
    const issue = pageRangeIssue(v.page_start, v.page_end);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['page_end'] });
  });

const UnitOut = z
  .strictObject({
    key: Key,
    title: Title,
    summary: Summary,
    page_start: PageNumber,
    page_end: PageNumber,
    match_existing_node_id: z.string().min(1).max(64).nullable(),
    topics: z.array(TopicOut).min(1).max(50),
  })
  .superRefine((v, ctx) => {
    const issue = pageRangeIssue(v.page_start, v.page_end);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['page_end'] });
  });

/** T1 / T1b output (ing-03, ING-05, ING-01.3). Page numbers are original numbers of the slice. */
export const Outline = z
  .strictObject({
    is_study_material: z.boolean(),
    language: LanguageTag,
    detected_kind: z.enum(['slides', 'notes', 'textbook', 'past_test', 'content_list']),
    title_suggestion: z.string().min(1).max(120),
    units: z.array(UnitOut).max(30),
  })
  .superRefine((v, ctx) => {
    if (v.is_study_material && v.units.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'material de estudo sem unidades', path: ['units'] });
    }
    if (!v.is_study_material && v.units.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'não é material de estudo: units deve ser vazio', path: ['units'] });
    }
  });

/** T2 output (ING-03.4): concepts of one topic. */
export const TopicConcepts = z.strictObject({
  concepts: z
    .array(
      z.strictObject({
        key: ConceptKey,
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(240),
        page_start: PageNumber,
        page_end: PageNumber,
        key_terms: z.array(z.string().min(1).max(60)).max(12),
        formulas: z.array(z.strictObject({ latex: z.string().min(1).max(300), description: z.string().min(1).max(200) })).max(6),
      }).superRefine((v, ctx) => {
        const issue = pageRangeIssue(v.page_start, v.page_end);
        if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['page_end'] });
      }),
    )
    .min(1)
    .max(15),
  /** Minutes a typical student needs to learn the topic from the pages sent, first time (GOL-04 §8.2.2). */
  study_minutes: z.number().int().min(3).max(240),
});

/** T3 output (ING-03.5): prerequisite edges. Cycles are dropped in code. */
export const PrereqEdges = z.strictObject({
  edges: z
    .array(
      z
        .strictObject({ node_key: NodeKey, prerequisite_key: NodeKey, reason: z.string().min(1).max(200) })
        .superRefine((v, ctx) => {
          if (v.node_key === v.prerequisite_key) ctx.addIssue({ code: 'custom', message: 'nó não pode ser pré-requisito de si mesmo', path: ['prerequisite_key'] });
        }),
    )
    .max(200),
});

/** T4 output (ING-02.6): transcription of scanned pages, used for search and highlighting. */
export const PageTranscriptions = z.strictObject({
  pages: z
    .array(z.strictObject({ page: PageNumber, text: z.string().max(8000), confidence: z.enum(['high', 'medium', 'low']) }))
    .min(1)
    .max(20),
});

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data ISO YYYY-MM-DD');
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora HH:mm');

/** T6 output (ING-07): exam schedule extraction. Stored as draft exams only. */
export const ScheduleImport = z.strictObject({
  term_name: z.string().min(1).max(60).nullable(),
  exams: z
    .array(
      z.strictObject({
        subject_name: z.string().min(1).max(80),
        date: IsoDate,
        date_ambiguous: z.boolean(),
        time: Hhmm.nullable(),
        weight: z.number().min(0).max(100).nullable(),
        label: z.string().min(1).max(40).nullable(),
        content_items: z.array(z.string().min(1).max(200)).max(50),
      }),
    )
    .max(20),
  warnings: z.array(z.string().min(1).max(200)).max(10),
});

const ScopeItem = z
  .strictObject({
    raw_text: z.string().min(1).max(300),
    normalized_title: z.string().min(1).max(120),
    matches: z.array(z.strictObject({ node_key: NodeKey, confidence: Confidence })).max(3),
    status: z.enum(['matched', 'partial', 'unmatched']),
    note: z.string().min(1).max(200).nullable(),
  })
  .superRefine((v, ctx) => {
    const best = Math.max(0, ...v.matches.map((m) => m.confidence));
    if (v.status === 'matched' && best < 0.8) ctx.addIssue({ code: 'custom', message: 'matched exige confiança ≥ 0,8', path: ['status'] });
    if (v.status === 'partial' && (best < 0.4 || best >= 0.8)) ctx.addIssue({ code: 'custom', message: 'partial exige confiança entre 0,4 e 0,8', path: ['status'] });
    if (v.status === 'unmatched' && best >= 0.4) ctx.addIssue({ code: 'custom', message: 'unmatched com confiança ≥ 0,4', path: ['status'] });
  });

/** GOL-03.2 output: content list mapped onto the knowledge map. */
export const ScopeMatch = z.strictObject({
  items: z.array(ScopeItem).min(1).max(60),
  detected_exam_info: z.strictObject({
    subject_guess: z.string().min(1).max(80).nullable(),
    date_guess: IsoDate.nullable(),
  }),
});

