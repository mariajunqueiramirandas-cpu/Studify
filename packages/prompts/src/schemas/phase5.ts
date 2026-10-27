import { z } from 'zod';
import { DocLabel, DocPageRef, NodeKey, PageNumber } from './common.ts';

// Phase 5 output schemas: auto visuals (spec 02 §7 L8), material checker (spec 01 §7 T5), mnemonics (spec 04 §7),
// Dividir e conquistar and Perguntas da turma (spec 10 §7.2–7.3) and the Retrospectiva title (spec 13 §7).
// Limits mirror LRN-05.6; the server re-checks them (visualSpecErrors) and maps doc labels to document ids.

const Title = z.string().min(1).max(120);
const AltText = z.string().min(20).max(1000);
const ItemId = z.string().min(1).max(40);
const Label = z.string().min(1).max(160);
const Detail = z.string().max(400).nullable();
const Source = DocPageRef.nullable();

const VisualNodeOut = z.strictObject({ id: ItemId, label: Label, detail: Detail, source: Source });

const FlowchartOut = z.strictObject({
  type: z.literal('flowchart'),
  title: Title,
  alt_text: AltText,
  nodes: z.array(VisualNodeOut).min(2).max(12),
  edges: z.array(z.strictObject({ from: ItemId, to: ItemId, label: z.string().max(60).nullable() })).min(1).max(30),
});
const CycleOut = z.strictObject({ type: z.literal('cycle'), title: Title, alt_text: AltText, nodes: z.array(VisualNodeOut).min(3).max(12) });
const TimelineOut = z.strictObject({
  type: z.literal('timeline'),
  title: Title,
  alt_text: AltText,
  events: z
    .array(z.strictObject({ id: ItemId, date_label: z.string().min(1).max(40), sort_key: z.number(), title: Label, detail: Detail, source: Source }))
    .min(2)
    .max(15),
});
const ComparisonOut = z.strictObject({
  type: z.literal('comparison_table'),
  title: Title,
  alt_text: AltText,
  columns: z.array(z.strictObject({ id: ItemId, label: z.string().min(1).max(60) })).min(2).max(4),
  rows: z.array(z.strictObject({ criterion: z.string().min(1).max(80), cells: z.array(z.string().max(200)).min(2).max(4), source: Source })).min(1).max(8),
});
const HierarchyOut = z.strictObject({
  type: z.literal('hierarchy'),
  title: Title,
  alt_text: AltText,
  nodes: z.array(z.strictObject({ id: ItemId, label: Label, detail: Detail, source: Source, parent_id: ItemId.nullable() })).min(2).max(20),
});

/** L8 visual spec. z.union (anyOf) rather than a discriminated union, as structured outputs require. */
export const VisualOut = z
  .strictObject({
    fits: z.boolean(),
    /** When nothing fits: why, in one short sentence for the student. */
    reason: z.string().max(200).nullable(),
    visual: z.union([FlowchartOut, CycleOut, TimelineOut, ComparisonOut, HierarchyOut]).nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.fits !== (v.visual !== null)) ctx.addIssue({ code: 'custom', message: 'visual presente se e somente se fits = true', path: ['visual'] });
  });
export type VisualOutput = z.infer<typeof VisualOut>;

// What the model writes. A union of the five visual types is too large for structured outputs ("The compiled
// grammar is too large"), so the model fills one flat object: `type` plus the lists that type uses, the
// other lists empty. decodeVisual rebuilds the typed visual and checks it against VisualOut.
export const VisualDraft = z.strictObject({
  fits: z.boolean(),
  reason: z.string().max(200).nullable(),
  type: z.enum(['flowchart', 'cycle', 'timeline', 'comparison_table', 'hierarchy', 'none']),
  title: z.string().max(120),
  alt_text: z.string().max(1000),
  nodes: z.array(z.strictObject({ id: ItemId, label: Label, detail: Detail, source: Source, parent_id: ItemId.nullable() })).max(20),
  edges: z.array(z.strictObject({ from: ItemId, to: ItemId, label: z.string().max(60).nullable() })).max(30),
  events: z
    .array(z.strictObject({ id: ItemId, date_label: z.string().min(1).max(40), sort_key: z.number(), title: Label, detail: Detail, source: Source }))
    .max(15),
  columns: z.array(z.strictObject({ id: ItemId, label: z.string().min(1).max(60) })).max(4),
  rows: z.array(z.strictObject({ criterion: z.string().min(1).max(80), cells: z.array(z.string().max(200)).max(4), source: Source })).max(8),
});
export type VisualDraftOutput = z.infer<typeof VisualDraft>;

/** The typed visual for a model draft, or null when the draft does not make a valid visual of its type. */
export function decodeVisual(draft: VisualDraftOutput): VisualOutput | null {
  if (!draft.fits || draft.type === 'none') {
    const none = VisualOut.safeParse({ fits: false, reason: draft.reason, visual: null });
    return none.success ? none.data : null;
  }
  const head = { type: draft.type, title: draft.title, alt_text: draft.alt_text };
  const flatNodes = draft.nodes.map(({ parent_id: _parent, ...node }) => node);
  const visual =
    draft.type === 'flowchart'
      ? { ...head, nodes: flatNodes, edges: draft.edges }
      : draft.type === 'cycle'
        ? { ...head, nodes: flatNodes }
        : draft.type === 'timeline'
          ? { ...head, events: draft.events }
          : draft.type === 'comparison_table'
            ? { ...head, columns: draft.columns, rows: draft.rows }
            : { ...head, nodes: draft.nodes };
  const parsed = VisualOut.safeParse({ fits: true, reason: draft.reason, visual });
  return parsed.success ? parsed.data : null;
}

/** T5 material checker. Findings are possibilities ("Possível erro"), never corrections applied by themselves. */
export const MaterialFindings = z.strictObject({
  findings: z
    .array(
      z
        .strictObject({
          type: z.enum(['contradiction', 'numeric_or_formula_typo', 'skipped_step', 'unclear']),
          severity: z.enum(['low', 'medium', 'high']),
          doc: DocLabel,
          page_start: PageNumber,
          page_end: PageNumber,
          /** The other side of a contradiction: a page of this document, or another document (O1, O2…). */
          related: z
            .strictObject({ doc: z.string().regex(/^(D\d{1,2}|O\d{1,2})$/), page: PageNumber.nullable() })
            .nullable(),
          node_key: NodeKey.nullable(),
          description: z.string().min(10).max(600),
          suggested_fix: z.string().max(600).nullable(),
        })
        .superRefine((f, ctx) => {
          if (f.page_end < f.page_start) ctx.addIssue({ code: 'custom', message: 'page_end menor que page_start', path: ['page_end'] });
          if (f.type === 'contradiction' && f.related === null) ctx.addIssue({ code: 'custom', message: 'contradição precisa do outro lado (related)', path: ['related'] });
        }),
    )
    .max(20),
});
export type MaterialFindingsOutput = z.infer<typeof MaterialFindings>;

/** Mnemonic options (MEM-06.3): exactly 3, in PT-BR, appropriate for minors. */
export const MnemonicOptions = z.strictObject({
  options: z
    .array(
      z.strictObject({
        type: z.enum(['acronym', 'phrase', 'rhyme', 'story', 'palace', 'keyword']),
        title: z.string().min(1).max(120),
        text: z.string().min(1).max(1200),
        how_to_use: z.string().min(1).max(300),
        /** Palácio da memória: each item placed on a locus, in order, with the vivid image. */
        loci: z.array(z.strictObject({ locus: z.string().min(1).max(60), item: z.string().min(1).max(120), image: z.string().min(1).max(300) })).max(20).nullable(),
      }),
    )
    .length(3),
});
export type MnemonicOptionsOutput = z.infer<typeof MnemonicOptions>;

/** SOC-06.3 private review of one contribution (spec 10 §7.2 step 1). */
export const ContributionReview = z.strictObject({
  errors: z.array(z.strictObject({ quote: z.string().min(1).max(300), correction: z.string().min(1).max(400), source: DocPageRef.nullable() })).max(10),
  missing_concepts: z.array(z.string().min(1).max(120)).max(8),
  ok_to_merge: z.boolean(),
  summary: z.string().min(1).max(400),
});
export type ContributionReviewOutput = z.infer<typeof ContributionReview>;

/** SOC-07.2 peer question validation (spec 10 §7.3). */
export const PeerQuestionValidation = z.strictObject({
  grounded: z.boolean(),
  evidence: z.array(DocPageRef).max(6),
  single_correct_answer: z.boolean(),
  clarity_issues: z.array(z.string().min(1).max(200)).max(5),
  appropriate: z.boolean(),
  /** Key of a near-duplicate from the candidate list (Q1, Q2…), or null. */
  duplicate_of: z.string().regex(/^Q\d{1,2}$/).nullable(),
  suggested_fix: z
    .strictObject({ stem: z.string().min(5).max(2000), payload_json: z.string().min(2).max(6000), explanation: z.string().max(2000).nullable() })
    .nullable(),
});
export type PeerQuestionValidationOutput = z.infer<typeof PeerQuestionValidation>;

/** MOT-04.4 Retrospectiva title. */
export const RetroTitle = z.strictObject({
  title_pt: z.string().min(3).max(60),
  subtitle_pt: z.string().min(3).max(120),
});
export type RetroTitleOutput = z.infer<typeof RetroTitle>;
