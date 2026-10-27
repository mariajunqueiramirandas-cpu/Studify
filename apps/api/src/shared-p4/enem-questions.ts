// ENEM-style questions from the student's material (ENM-03, spec 09 §7.5): texto-base + comando + 5 alternatives,
// tagged with a skill and a difficulty band. Excerpts must match the cited page text (deterministic check), or the
// question is dropped. Generated questions are never TRI-scored (ENM-03.4).
import { getTask } from '@studify/prompts';
import { ApiFailure, parseQuestionPayload, type EnemArea } from '@studify/shared';
import { callTask, unwrapResult } from '../shared/ai.ts';
import type { SubjectRow } from '../shared/access.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { loadTopic, topicInput, topicSlices } from '../shared/topic.ts';

interface GeneratedItem {
  texto_base: {
    kind: 'excerpt' | 'written' | 'chart' | 'table';
    content_md: string;
    chart_data: unknown;
    source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
    label: string | null;
  };
  comando_md: string;
  alternatives: Array<{ label: string; text_md: string }>;
  answer: string;
  explanation_md: string;
  distractor_rationales: Array<{ label: string; why: string }>;
  skill_code: string;
  difficulty: 'facil' | 'media' | 'dificil';
  source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
}

/** Letters, digits and spaces only, lowercase, single-spaced: tolerant to line breaks and punctuation. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** ENM-03.3: an excerpt must be text of the cited pages (ellipses split it into parts that must each match). */
export function excerptMatches(excerpt: string, pageTexts: readonly string[]): boolean {
  const haystack = normalizeForMatch(pageTexts.join(' '));
  const parts = excerpt
    .replace(/^>\s?/gm, '')
    .split(/\[\s*\.\.\.\s*\]|\(\s*\.\.\.\s*\)|…|\.\.\./)
    .map(normalizeForMatch)
    .filter((p) => p.length >= 12);
  return parts.length > 0 && parts.every((p) => haystack.includes(p));
}

export async function generateEnemQuestionsForNode(deps: Deps, nodeId: string, options: { count?: number; subject: SubjectRow; userId: string }): Promise<string[]> {
  const area = options.subject.enem_area as EnemArea | null;
  if (!area) throw new ApiFailure('invalid_request', { message: 'Essa matéria não está ligada a uma área do ENEM.' });
  const bundle = await loadTopic(deps.db, options.userId, nodeId);
  const { slices } = await topicSlices(deps, bundle);
  const node = await deps.db.from('knowledge_nodes').select('enem_skill_codes').eq('id', nodeId).maybeSingle();
  if (node.error) throw node.error;
  const codes = (node.data?.enem_skill_codes as string[] | null) ?? [];
  let skillsQuery = deps.db.from('enem_skills').select('code, competency_no, description').eq('area', area);
  if (codes.length > 0) skillsQuery = skillsQuery.in('code', codes);
  const skills = await skillsQuery.order('skill_no');
  if (skills.error) throw skills.error;
  const skillRows = skills.data as Array<{ code: string; competency_no: number; description: string | null }>;
  const examples = await deps.db
    .from('enem_items')
    .select('edition_year, co_item, transcription_md')
    .eq('area', area)
    .eq('review_status', 'ok')
    .in('skill_code', skillRows.map((s) => s.code).slice(0, 30))
    .not('transcription_md', 'is', null)
    .order('edition_year', { ascending: false })
    .limit(3);
  if (examples.error) throw examples.error;
  const existing = await deps.db.from('questions').select('stem').eq('node_id', nodeId).eq('enem_style', true).eq('status', 'active').is('deleted_at', null).limit(30);
  if (existing.error) throw existing.error;

  const count = options.count ?? 5;
  const built = getTask('enem.question.generate').build({
    area,
    topic: topicInput(bundle),
    slices,
    skills: skillRows.map((s) => ({ code: s.code, competency: s.competency_no, description: s.description })),
    examples: (examples.data as Array<{ edition_year: number; co_item: string; transcription_md: string }>).map((e) => ({ ref: `ENEM ${e.edition_year} (${e.co_item})`, transcriptionMd: e.transcription_md.slice(0, 2500) })),
    count,
    existingStems: (existing.data as Array<{ stem: string }>).map((r) => r.stem),
    contentLanguage: bundle.contentLanguage,
    languageSubject: bundle.languageSubject,
  });
  const result = await callTask(claudeDepsFor(deps), { built, taskId: 'enem.question.generate', ctx: budgetCtxFor(options.subject, options.userId, 'ENM-03', 'user', { nodeId }) });
  const data = unwrapResult(result) as { items: GeneratedItem[] };
  const labels = built.documents?.labels ?? {};
  const validCodes = new Set(skillRows.map((s) => s.code));

  // Page texts for the excerpt check, loaded once per document.
  const pageCache = new Map<string, Map<number, string>>();
  const pageText = async (documentId: string, pages: number[]): Promise<string[]> => {
    let byPage = pageCache.get(documentId);
    if (!byPage) {
      const res = await deps.db.from('document_pages').select('page_number, text').eq('document_id', documentId);
      if (res.error) throw res.error;
      byPage = new Map((res.data as Array<{ page_number: number; text: string | null }>).map((p) => [p.page_number, p.text ?? '']));
      pageCache.set(documentId, byPage);
    }
    return pages.map((p) => byPage!.get(p) ?? '');
  };

  const rows: Record<string, unknown>[] = [];
  for (const item of data.items.slice(0, count)) {
    if (!validCodes.has(item.skill_code)) continue;
    if (item.texto_base.kind === 'excerpt') {
      const texts: string[] = [];
      for (const ref of item.texto_base.source_pages) {
        const docId = labels[ref.doc];
        if (!docId) continue;
        const pages: number[] = [];
        for (let p = ref.page_start; p <= ref.page_end; p++) pages.push(p);
        texts.push(...(await pageText(docId, pages)));
      }
      if (!excerptMatches(item.texto_base.content_md, texts)) continue;
    }
    const rationale = new Map(item.distractor_rationales.map((r) => [r.label, r.why]));
    let payload;
    try {
      payload = parseQuestionPayload('mcq_single', {
        options: item.alternatives.map((a) => ({ id: a.label, text: a.text_md, rationale: a.label === item.answer ? item.explanation_md : (rationale.get(a.label) ?? 'Alternativa incorreta.') })),
        correct: item.answer,
      });
    } catch {
      continue;
    }
    const toStorage = (refs: GeneratedItem['source_pages']) =>
      refs.filter((r) => labels[r.doc]).map((r) => ({ document_id: labels[r.doc], page_start: r.page_start, page_end: r.page_end }));
    rows.push({
      id: deps.newId(),
      subject_id: options.subject.id,
      node_id: nodeId,
      concept_ids: [],
      type: 'mcq_single',
      stem: item.comando_md,
      stimulus: null,
      texto_base: {
        kind: item.texto_base.kind,
        content_md: item.texto_base.content_md,
        ...(item.texto_base.chart_data ? { chart_data: item.texto_base.chart_data } : {}),
        ...(item.texto_base.source_pages.length ? { source_pages: toStorage(item.texto_base.source_pages) } : {}),
        ...(item.texto_base.label ? { label: item.texto_base.label } : {}),
      },
      payload,
      explanation: item.explanation_md,
      bloom_level: 'apply',
      difficulty: item.difficulty === 'facil' ? 2 : item.difficulty === 'media' ? 3 : 4,
      difficulty_band: item.difficulty,
      enem_skill_code: item.skill_code,
      enem_style: true,
      source_pages: toStorage(item.source_pages),
      origin: 'generated',
      has_math: /\$/.test(item.comando_md) || /\$/.test(item.texto_base.content_md),
      prompt_version: getTask('enem.question.generate').promptVersion,
      status: 'active',
      review_status: 'approved',
    });
  }
  if (rows.length === 0) return [];
  const inserted = await deps.db.from('questions').insert(rows);
  if (inserted.error) throw inserted.error;
  return rows.map((r) => r.id as string);
}
