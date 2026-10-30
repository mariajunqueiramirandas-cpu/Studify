// Outline post-processing (spec 01 §7–8, ING-03.1–3, ING-03.9, ING-03.14). Pure: model output in, clamped
// tree out. Page ranges are clamped to the document's pages; matches to existing nodes are validated
// against the subject; sanity limits truncate with a warning rather than failing the document.

export interface OutlineTopicOut {
  key: string;
  title: string;
  summary: string;
  learning_objectives: string[];
  page_start: number;
  page_end: number;
  match_existing_node_id: string | null;
}

export interface OutlineUnitOut {
  key: string;
  title: string;
  summary: string;
  page_start: number;
  page_end: number;
  match_existing_node_id: string | null;
  topics: OutlineTopicOut[];
}

export interface OutlineOut {
  is_study_material: boolean;
  language: string;
  detected_kind: 'slides' | 'notes' | 'textbook' | 'past_test' | 'content_list';
  title_suggestion: string;
  /** The document only lists its chapters: they get written (ING-03.16, apostila.ts). */
  lists_only: boolean;
  units: OutlineUnitOut[];
}

export interface NormalizedTopic {
  key: string;
  title: string;
  summary: string;
  objectives: string[];
  pageStart: number;
  pageEnd: number;
  /** Existing topic this one merges into (ING-03.9), or null for a new topic. */
  matchId: string | null;
}

export interface NormalizedUnit {
  key: string;
  title: string;
  summary: string;
  pageStart: number;
  pageEnd: number;
  matchId: string | null;
  topics: NormalizedTopic[];
}

export interface NormalizedOutline {
  isStudyMaterial: boolean;
  language: string;
  detectedKind: OutlineOut['detected_kind'];
  units: NormalizedUnit[];
  warnings: string[];
}

export const MAX_UNITS = 30;
export const MAX_TOPICS_PER_UNIT = 50;
export const MAX_TOPICS_PER_SUBJECT = 300;

export interface NormalizeOptions {
  pageCount: number;
  existingUnitIds: ReadonlySet<string>;
  existingTopicIds: ReadonlySet<string>;
  /** Topics already in the subject (merge path), counted against MAX_TOPICS_PER_SUBJECT. */
  existingTopicCount: number;
}

/** Clamps a range to 1..pageCount. A range entirely outside the document is dropped (null). */
function clampRange(start: number, end: number, pageCount: number): { start: number; end: number } | null {
  if (start > pageCount || end < 1) return null;
  const s = Math.min(pageCount, Math.max(1, Math.floor(start)));
  const e = Math.min(pageCount, Math.max(1, Math.floor(end)));
  return e >= s ? { start: s, end: e } : null;
}

export function normalizeOutline(raw: OutlineOut, options: NormalizeOptions): NormalizedOutline {
  const warnings: string[] = [];
  if (!raw.is_study_material) {
    return { isStudyMaterial: false, language: raw.language, detectedKind: raw.detected_kind, units: [], warnings };
  }
  const units: NormalizedUnit[] = [];
  let topicCount = options.existingTopicCount;
  for (const unit of raw.units) {
    if (units.length >= MAX_UNITS) {
      warnings.push(`mais de ${MAX_UNITS} unidades: as demais foram ignoradas`);
      break;
    }
    const unitRange = clampRange(unit.page_start, unit.page_end, options.pageCount);
    if (!unitRange) continue;
    const topics: NormalizedTopic[] = [];
    for (const topic of unit.topics.slice(0, MAX_TOPICS_PER_UNIT)) {
      const range = clampRange(topic.page_start, topic.page_end, options.pageCount);
      if (!range) continue;
      const matchId =
        topic.match_existing_node_id && options.existingTopicIds.has(topic.match_existing_node_id)
          ? topic.match_existing_node_id
          : null;
      if (!matchId) {
        if (topicCount >= MAX_TOPICS_PER_SUBJECT) {
          warnings.push(`mais de ${MAX_TOPICS_PER_SUBJECT} tópicos na matéria: o excedente foi ignorado`);
          continue;
        }
        topicCount++;
      }
      topics.push({
        key: topic.key,
        title: topic.title,
        summary: topic.summary,
        objectives: topic.learning_objectives,
        pageStart: range.start,
        pageEnd: range.end,
        matchId,
      });
    }
    const unitMatch =
      unit.match_existing_node_id && options.existingUnitIds.has(unit.match_existing_node_id)
        ? unit.match_existing_node_id
        : null;
    units.push({
      key: unit.key,
      title: unit.title,
      summary: unit.summary,
      pageStart: unitRange.start,
      pageEnd: unitRange.end,
      matchId: unitMatch,
      topics,
    });
  }
  if (units.length === 0) {
    return { isStudyMaterial: false, language: raw.language, detectedKind: raw.detected_kind, units: [], warnings };
  }
  return { isStudyMaterial: true, language: raw.language, detectedKind: raw.detected_kind, units, warnings };
}

/** Pages of a topic claimed by two topics in the same unit overlap by at most one page (spec 01 §7). */
export function overlapViolations(units: readonly NormalizedUnit[]): number {
  let violations = 0;
  for (const unit of units) {
    const sorted = [...unit.topics].sort((a, b) => a.pageStart - b.pageStart);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.pageEnd - cur.pageStart > 1) violations++;
    }
  }
  return violations;
}
