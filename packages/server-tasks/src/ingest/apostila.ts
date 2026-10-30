// ING-03.16: a document that only lists its chapters (sumário, ementa, plano de ensino) gets them written. S1 flags
// it (`lists_only`); the listed topics are written from general textbook knowledge, a few per call, and laid out as a
// text PDF, the "Apostila Studify", which joins the subject as its own document. Its map is the list's outline placed
// on the apostila's pages, so notes, cards and questions cite pages the student can open like any other material.
// The list itself stays in the subject without nodes and follows the apostila's status.
import { createHash } from 'node:crypto';
import { callClaude } from '@studify/ai';
import { getTask, type WriteChaptersInput } from '@studify/prompts';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type pg from 'pg';
import type { Sql } from '../framework/db.ts';
import { mapLimit } from './concurrency.ts';
import { budgetFor, type PipelineEnv } from './env.ts';
import { withS1Retries, writeOutline } from './outline.ts';
import type { OutlineOut, OutlineTopicOut, OutlineUnitOut } from './outline-normalize.ts';
import { prepareCall } from './tasks.ts';
import { BUCKET } from './store.ts';
import type { DocumentRecord } from './repo.ts';
import { withShortCache } from '../lib/ai-adapter.ts';

/** Marks a PDF as written by Studify, so an apostila is never expanded again. */
export const APOSTILA_KEYWORD = 'studify-apostila';
/** Topics written per call: a unit's chapter text stays well inside one structured answer. */
export const TOPICS_PER_CALL = 8;
export const WRITE_CONCURRENCY = 4;
/**
 * Topics written for one list. A whole textbook's sumário is still one material, and a budget refusal re-runs the
 * writing from the start the next day: the list is cut here rather than never fitting.
 */
export const MAX_WRITTEN_TOPICS = 60;

export interface WrittenSection {
  heading: string;
  paragraphs: string[];
}

export function isApostila(pdf: PDFDocument): boolean {
  return (pdf.getKeywords() ?? '').includes(APOSTILA_KEYWORD);
}

/** The apostila's document id: derived from the list's, so a retried list finds the one it already wrote. */
export function apostilaDocumentId(listDocumentId: string): string {
  const hex = createHash('sha256').update(`apostila:${listDocumentId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The list's units cut to MAX_WRITTEN_TOPICS topics, in list order; units left without topics are dropped. */
export function capListedUnits(units: readonly OutlineUnitOut[], max = MAX_WRITTEN_TOPICS): OutlineUnitOut[] {
  const out: OutlineUnitOut[] = [];
  let left = max;
  for (const unit of units) {
    if (left <= 0) break;
    const topics = unit.topics.slice(0, left);
    left -= topics.length;
    if (topics.length > 0) out.push({ ...unit, topics });
  }
  return out;
}

/** One writing call: a unit's topics, at most TOPICS_PER_CALL of them. */
export interface WriteChunk {
  unitIndex: number;
  topicIndexes: number[];
}

export function writeChunks(units: readonly OutlineUnitOut[]): WriteChunk[] {
  const chunks: WriteChunk[] = [];
  units.forEach((unit, unitIndex) => {
    for (let start = 0; start < unit.topics.length; start += TOPICS_PER_CALL) {
      const end = Math.min(unit.topics.length, start + TOPICS_PER_CALL);
      chunks.push({ unitIndex, topicIndexes: Array.from({ length: end - start }, (_v, i) => start + i) });
    }
  });
  return chunks;
}

/** A topic the model left out still gets a page: what the list says about it. */
function fallbackSections(topic: OutlineTopicOut): WrittenSection[] {
  return [
    { heading: 'Do que se trata', paragraphs: [topic.summary] },
    { heading: 'O que estudar', paragraphs: topic.learning_objectives.map((o) => `- ${o}`) },
  ];
}

/**
 * Writes every listed topic. Returns the sections per unit and topic, in list order. Throws BudgetExceededError
 * (the pipeline parks the list as waiting_budget).
 */
export async function writeChapters(
  env: PipelineEnv,
  doc: DocumentRecord,
  units: readonly OutlineUnitOut[],
  opts: { jobId: string | null; contentLanguage: string },
): Promise<{ status: 'ok'; sections: WrittenSection[][][] } | { status: 'failed'; code: 'ai_failed' | 'ai_refused' }> {
  const sections: WrittenSection[][][] = units.map((u) => u.topics.map(fallbackSections));
  const chunks = writeChunks(units);
  const results = await mapLimit(chunks, WRITE_CONCURRENCY, async (chunk) => {
    const unit = units[chunk.unitIndex]!;
    const topics = chunk.topicIndexes.map((t, i) => {
      const topic = unit.topics[t]!;
      return { key: `T${i + 1}`, title: topic.title, summary: topic.summary, objectives: topic.learning_objectives };
    });
    const input: WriteChaptersInput = {
      subjectName: doc.subjectName,
      fileName: doc.title,
      unit: { title: unit.title, summary: unit.summary },
      topics,
      otherUnitTitles: units.filter((_u, i) => i !== chunk.unitIndex).map((u) => u.title),
      contentLanguage: opts.contentLanguage,
      languageSubject: doc.isLanguageSubject,
    };
    const built = getTask('ingest.writeChapters').build(input);
    const budget = budgetFor({ ...doc, documentId: doc.id }, { jobId: opts.jobId, feature: 'ING-03.16' });
    const prepared = prepareCall('ingest.writeChapters', built, budget, [], { node: topics.map((t) => t.key) });
    const call = () => callClaude(env.ctx.ai, withShortCache(prepared.call));
    return withS1Retries(env, () => (env.ctx.aiLane ? env.ctx.aiLane({ position: -1 }, call) : call()));
  });
  for (let c = 0; c < chunks.length; c++) {
    const result = results[c]!;
    if (result.status === 'refused') return { status: 'failed', code: 'ai_refused' };
    if (result.status !== 'ok') return { status: 'failed', code: 'ai_failed' };
    const chunk = chunks[c]!;
    const written = (result.data as { topics: Array<{ key: string; sections: WrittenSection[] }> }).topics;
    for (const topic of written) {
      const index = Number(topic.key.slice(1)) - 1;
      const t = chunk.topicIndexes[index];
      if (t === undefined || topic.sections.length === 0) continue;
      sections[chunk.unitIndex]![t] = topic.sections;
    }
  }
  return { status: 'ok', sections };
}

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

export interface ApostilaLayoutInput {
  subjectName: string;
  listTitle: string;
  units: ReadonlyArray<{ title: string; topics: ReadonlyArray<{ title: string; sections: readonly WrittenSection[] }> }>;
}

export interface PageRange {
  start: number;
  end: number;
}

export interface ApostilaPdf {
  bytes: Uint8Array;
  pageCount: number;
  /** Pages of each unit and of each of its topics, 1-based, in input order. */
  units: Array<PageRange & { topics: PageRange[] }>;
}

const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const BODY = { size: 11, leading: 15.5 };
const INK = rgb(0.13, 0.13, 0.15);
const MUTED = rgb(0.42, 0.42, 0.46);

/** Characters the standard fonts cannot draw, written out. Anything else outside WinAnsi becomes "?". */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '→': '->', '←': '<-', '⇒': '=>', '↔': '<->', '⇔': '<=>', '−': '-', '∙': '·', '⋅': '·',
  '√': 'raiz de ', '∞': 'infinito', '∆': 'Delta ', 'Δ': 'Delta ', 'Σ': 'Soma ', 'Ω': 'ohm', 'α': 'alfa', 'β': 'beta', 'γ': 'gama',
  'δ': 'delta', 'ε': 'épsilon', 'θ': 'teta', 'λ': 'lambda', 'μ': 'µ', 'π': 'pi', 'ρ': 'rô', 'σ': 'sigma', 'τ': 'tau', 'φ': 'fi', 'ω': 'ômega',
  '′': "'", '″': '"', ' ': ' ', '\t': ' ', ' ': ' ', ' ': ' ',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '⁰': '^0', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9', '⁻': '^-', '⁺': '^+', 'ⁿ': '^n',
};

/** Text the font can encode: known symbols written out, accents kept when the font has them, the rest as "?". */
export function drawableText(text: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0)!;
    if (supported.has(code)) out += ch;
    else if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (ch === '\n') out += ' ';
    else {
      const bare = ch.normalize('NFD').replace(/\p{M}/gu, '');
      out += bare && [...bare].every((c) => supported.has(c.codePointAt(0)!)) ? bare : '?';
    }
  }
  return out;
}

/** Greedy line breaking; a word wider than the line is cut. */
export function wrapLines(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Lays the apostila out: a cover, then each topic from a new page, the unit's title above its first topic. */
export async function buildApostilaPdf(input: ApostilaLayoutInput): Promise<ApostilaPdf> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE[0] - 2 * MARGIN;
  doc.setTitle(drawableText(`Apostila Studify: ${input.listTitle}`, regular));
  doc.setSubject(drawableText(input.subjectName, regular));
  doc.setCreator('Studify');
  doc.setKeywords([APOSTILA_KEYWORD]);

  const top = PAGE[1] - MARGIN;
  let page: PDFPage = doc.addPage(PAGE);
  let y = top;
  const newPage = () => {
    page = doc.addPage(PAGE);
    y = top;
  };
  const block = (text: string, font: PDFFont, size: number, leading: number, opts: { color?: ReturnType<typeof rgb>; indent?: number; before?: number; keepWith?: number } = {}) => {
    const indent = opts.indent ?? 0;
    const lines = wrapLines(drawableText(text, font), font, size, width - indent);
    if (y !== top) y -= opts.before ?? 0;
    // A heading moves to the next page together with the first lines of what follows it.
    if (opts.keepWith !== undefined && y !== top && y - leading * lines.length - BODY.leading * opts.keepWith < MARGIN) newPage();
    for (const line of lines) {
      if (y - leading < MARGIN) newPage();
      y -= leading;
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: opts.color ?? INK });
    }
  };

  block('Apostila Studify', bold, 26, 34);
  block(input.subjectName, regular, 16, 24, { before: 6, color: MUTED });
  block(`Escrita pelo Studify a partir da lista de capítulos "${input.listTitle}".`, regular, BODY.size, BODY.leading, { before: 28 });
  block(
    'O arquivo enviado só listava os capítulos, sem o conteúdo. Este texto foi escrito por IA a partir do conteúdo de ensino médio de cada item: confira com o seu professor e com o livro da turma quando puder.',
    regular,
    BODY.size,
    BODY.leading,
    { before: 8, color: MUTED },
  );

  const units: ApostilaPdf['units'] = [];
  for (const unit of input.units) {
    const topics: PageRange[] = [];
    unit.topics.forEach((topic, i) => {
      newPage();
      const start = doc.getPageCount();
      if (i === 0) block(unit.title, bold, 18, 24, { color: MUTED });
      block(topic.title, bold, 15, 20, { before: i === 0 ? 10 : 0, keepWith: 3 });
      for (const section of topic.sections) {
        block(section.heading, bold, 12.5, 17, { before: 14, keepWith: 2 });
        for (const paragraph of section.paragraphs) {
          const bullet = paragraph.trimStart().startsWith('- ');
          block(paragraph.trim(), regular, BODY.size, BODY.leading, { before: bullet ? 2 : 6, indent: bullet ? 10 : 0 });
        }
      }
      topics.push({ start, end: doc.getPageCount() });
    });
    units.push({ start: topics[0]!.start, end: topics[topics.length - 1]!.end, topics });
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1}`;
    p.drawText(label, { x: PAGE[0] / 2 - regular.widthOfTextAtSize(label, 9) / 2, y: MARGIN / 2, size: 9, font: regular, color: MUTED });
  });
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, pageCount: pages.length, units };
}

/** The list's outline placed on the apostila's pages: the map the apostila document gets. */
export function apostilaOutline(outline: OutlineOut, units: readonly OutlineUnitOut[], layout: ApostilaPdf): OutlineOut {
  return {
    ...outline,
    detected_kind: 'notes',
    lists_only: false,
    units: units.map((unit, u) => ({
      ...unit,
      page_start: layout.units[u]!.start,
      page_end: layout.units[u]!.end,
      topics: unit.topics.map((topic, t) => ({ ...topic, page_start: layout.units[u]!.topics[t]!.start, page_end: layout.units[u]!.topics[t]!.end })),
    })),
  };
}

// ---------------------------------------------------------------------------
// The apostila document
// ---------------------------------------------------------------------------

/** The apostila of a list when it is already written and holds its map, else null. */
export async function writtenApostila(sql: Sql, listDocumentId: string): Promise<string | null> {
  const documentId = apostilaDocumentId(listDocumentId);
  const { rows } = await sql.query<{ n: string }>(
    `select count(*)::text as n from public.node_sources s join public.documents d on d.id = s.document_id
      where s.document_id = $1 and d.deleted_at is null and s.deleted_at is null`,
    [documentId],
  );
  return Number(rows[0]?.n ?? '0') > 0 ? documentId : null;
}

/** The list an apostila was written from, still waiting on it (its id derives the apostila's), else null. */
export async function listOfApostila(sql: Sql, apostila: Pick<DocumentRecord, 'id' | 'subjectId'>): Promise<string | null> {
  const { rows } = await sql.query<{ id: string }>(
    `select id from public.documents
      where subject_id = $1 and id <> $2 and deleted_at is null and status in ('processing', 'waiting_budget')`,
    [apostila.subjectId, apostila.id],
  );
  return rows.find((r) => apostilaDocumentId(r.id) === apostila.id)?.id ?? null;
}

export type ApostilaOutcome = { status: 'ok'; documentId: string } | { status: 'failed'; code: 'ai_failed' | 'ai_refused' };

/**
 * Writes the apostila of a list and its map. Idempotent: an apostila that already has its map is reused, so a retried
 * list never pays for the chapters twice. Throws BudgetExceededError.
 */
export async function writeApostila(env: PipelineEnv, list: DocumentRecord, outline: OutlineOut, opts: { jobId: string | null }): Promise<ApostilaOutcome> {
  const sql = env.ctx.sql;
  const documentId = apostilaDocumentId(list.id);
  if (await writtenApostila(sql, list.id)) return { status: 'ok', documentId };

  const units = capListedUnits(outline.units);
  const contentLanguage = list.contentLanguage ?? outline.language;
  const written = await writeChapters(env, list, units, { jobId: opts.jobId, contentLanguage });
  if (written.status === 'failed') return written;

  const layout = await buildApostilaPdf({
    subjectName: list.subjectName,
    listTitle: list.title,
    units: units.map((unit, u) => ({
      title: unit.title,
      topics: unit.topics.map((topic, t) => ({ title: topic.title, sections: written.sections[u]![t]! })),
    })),
  });
  const storagePath = `${list.subjectId}/${documentId}.pdf`;
  await env.store.upload(BUCKET.documents, storagePath, layout.bytes, 'application/pdf');
  const checksum = createHash('sha256').update(layout.bytes).digest('hex');
  await sql.query(
    `insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, page_count, checksum_sha256, language, status)
     values ($1, $2, $3, $4, 'notes', $5, $6, $7, $8, $9, 'uploaded')
     on conflict (id) do update set storage_path = excluded.storage_path, size_bytes = excluded.size_bytes,
       page_count = excluded.page_count, checksum_sha256 = excluded.checksum_sha256, updated_at = now()`,
    [documentId, list.subjectId, list.uploadedBy, `Apostila Studify: ${list.title}`.slice(0, 200), storagePath, layout.bytes.byteLength, layout.pageCount, checksum, outline.language],
  );
  await writeOutline(env.ctx.sql as pg.Pool, { id: documentId, subjectId: list.subjectId }, apostilaOutline(outline, units, layout), layout.pageCount);
  return { status: 'ok', documentId };
}
