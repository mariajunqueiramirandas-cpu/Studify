// ENEM bank import, pure parts (spec 09 §8.1): the ITENS_PROVA microdata table, the answer-key file, the
// "QUESTÃO n" markers of a booklet's text layer and the crop regions of each item. No I/O: the import job feeds
// these with the files an admin uploaded to enem/{year}/raw/.
import { detectParamScale, skillCodeFromMicrodata, type EnemArea, type TriParamScale } from '@studify/shared';
import type { TextSpanOut } from '../ingest/pdf-spans.ts';

/** enem/{year}/raw/manifest.json: which booklet (one color per day) and which CO_PROVA codes it carries. */
export interface ImportManifest {
  application?: 'regular' | 'ppl' | 'other';
  microdata: string;
  days: Array<{ day: 1 | 2; booklet: string; co_prova: Partial<Record<EnemArea, string>>; answer_key?: string; color?: string }>;
}

export interface MicrodataRow {
  position: number;
  area: EnemArea;
  coItem: string;
  key: string | null;
  skill: string | null;
  annulled: boolean;
  annulReason: string | null;
  a: number | null;
  b: number | null;
  c: number | null;
  color: string | null;
  coProva: string;
  language: 'en' | 'es' | null;
}

/** Splits one CSV line on `sep`, honoring double-quoted fields. */
function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

const decimal = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parses ITENS_PROVA_<ano>.csv (`;` or `,` separated; columns by name: CO_POSICAO, SG_AREA, CO_ITEM,
 * TX_GABARITO, CO_HABILIDADE, IN_ITEM_ABAN, TX_MOTIVO_ABAN, NU_PARAM_A/B/C, TX_COR, CO_PROVA, TP_LINGUA).
 * TP_LINGUA 0 = inglês, 1 = espanhol (column semantics to confirm in each year's dictionary).
 */
export function parseItensProva(csv: string): MicrodataRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const sep = (lines[0]!.match(/;/g)?.length ?? 0) >= (lines[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitCsv(lines[0]!, sep).map((h) => h.toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    pos: col('CO_POSICAO'),
    area: col('SG_AREA'),
    item: col('CO_ITEM'),
    key: col('TX_GABARITO'),
    skill: col('CO_HABILIDADE'),
    aban: col('IN_ITEM_ABAN'),
    motivo: col('TX_MOTIVO_ABAN'),
    a: col('NU_PARAM_A'),
    b: col('NU_PARAM_B'),
    c: col('NU_PARAM_C'),
    cor: col('TX_COR'),
    prova: col('CO_PROVA'),
    lingua: col('TP_LINGUA'),
  };
  if (idx.pos < 0 || idx.area < 0 || idx.item < 0 || idx.prova < 0) throw new Error('ITENS_PROVA: missing CO_POSICAO, SG_AREA, CO_ITEM or CO_PROVA');
  const rows: MicrodataRow[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsv(line, sep);
    const area = (f[idx.area] ?? '').toUpperCase() as EnemArea;
    if (!['LC', 'CH', 'CN', 'MT'].includes(area)) continue;
    const position = Number(f[idx.pos]);
    if (!Number.isInteger(position) || position < 1) continue;
    const rawKey = idx.key >= 0 ? (f[idx.key] ?? '').toUpperCase() : '';
    const lingua = idx.lingua >= 0 ? (f[idx.lingua] ?? '').trim() : '';
    rows.push({
      position,
      area,
      coItem: f[idx.item] ?? '',
      key: /^[A-E]$/.test(rawKey) ? rawKey : null,
      skill: idx.skill >= 0 ? skillCodeFromMicrodata(area, f[idx.skill] ?? null) : null,
      annulled: idx.aban >= 0 && (f[idx.aban] ?? '') === '1',
      annulReason: idx.motivo >= 0 && f[idx.motivo] ? f[idx.motivo]! : null,
      a: idx.a >= 0 ? decimal(f[idx.a]) : null,
      b: idx.b >= 0 ? decimal(f[idx.b]) : null,
      c: idx.c >= 0 ? decimal(f[idx.c]) : null,
      color: idx.cor >= 0 && f[idx.cor] ? f[idx.cor]! : null,
      coProva: f[idx.prova] ?? '',
      language: area === 'LC' && lingua === '0' ? 'en' : area === 'LC' && lingua === '1' ? 'es' : null,
    });
  }
  return rows;
}

export interface ItemGroup {
  coItem: string;
  area: EnemArea;
  key: string | null;
  skill: string | null;
  annulled: boolean;
  annulReason: string | null;
  language: 'en' | 'es' | null;
  params: { a: number; b: number; c: number } | null;
  positions: Array<{ co_prova: string; color: string | null; position: number }>;
}

/** One entry per CO_ITEM (an item appears once per booklet color), with every booklet position. */
export function groupItems(rows: readonly MicrodataRow[]): ItemGroup[] {
  const byItem = new Map<string, ItemGroup>();
  for (const r of rows) {
    const g = byItem.get(r.coItem) ?? {
      coItem: r.coItem,
      area: r.area,
      key: r.key,
      skill: r.skill,
      annulled: r.annulled,
      annulReason: r.annulReason,
      language: r.language,
      params: r.a !== null && r.b !== null && r.c !== null ? { a: r.a, b: r.b, c: r.c } : null,
      positions: [],
    };
    g.annulled = g.annulled || r.annulled;
    if (!g.positions.some((p) => p.co_prova === r.coProva)) g.positions.push({ co_prova: r.coProva, color: r.color, position: r.position });
    byItem.set(r.coItem, g);
  }
  return [...byItem.values()].sort((a, b) => a.coItem.localeCompare(b.coItem));
}

/** Scale of the edition's parameters (§8.1: median b > 50 → ENEM reporting scale). */
export function editionScale(groups: readonly ItemGroup[]): TriParamScale {
  return detectParamScale(groups.filter((g) => g.params).map((g) => g.params!.b));
}

/**
 * Official answer key as text: one "position letter" pair per line or several per line ("1 A 2 C …"); "Anulado"
 * or "X" marks an annulled position (null). Works on the text layer of the gabarito PDF too.
 */
export function parseAnswerKey(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const re = /\b(\d{1,3})\s*[-–:.)]?\s*(ANULAD[OA]|[A-E]|X)\b/gi;
  for (const m of text.matchAll(re)) {
    const pos = Number(m[1]);
    const v = m[2]!.toUpperCase();
    if (!out.has(pos)) out.set(pos, /^[A-E]$/.test(v) ? v : null);
  }
  return out;
}

export interface PageText {
  pageNumber: number;
  spans: readonly TextSpanOut[];
}

export interface QuestionMarker {
  /** The number printed after "QUESTÃO" (booklet position). */
  position: number;
  /** Occurrence of this number in the booklet (LC 1–5 appear twice: English, then Spanish). */
  occurrence: number;
  page: number;
  column: 0 | 1;
  /** Top of the marker, 0–1 from the top of the page. */
  y: number;
}

const MARKER = /^QUEST[ÃA]O\s*(\d{1,3})\b/i;

/**
 * "QUESTÃO n" markers, column-aware (two columns split at the middle of the page), in reading order. A marker
 * may be split over two spans ("QUESTÃO" + "91"), so adjacent spans on the same line are joined.
 */
export function findQuestionMarkers(pages: readonly PageText[]): QuestionMarker[] {
  const out: QuestionMarker[] = [];
  const seen = new Map<number, number>();
  for (const page of pages) {
    const spans = [...page.spans].sort((a, b) => a.y - b.y || a.x - b.x);
    const found: Array<Omit<QuestionMarker, 'occurrence'>> = [];
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!;
      let text = s.text.trim();
      const next = spans[i + 1];
      if (/^QUEST[ÃA]O$/i.test(text) && next && Math.abs(next.y - s.y) < 0.01) text = `${text} ${next.text.trim()}`;
      const m = MARKER.exec(text);
      if (!m) continue;
      found.push({ position: Number(m[1]), page: page.pageNumber, column: s.x + s.w / 2 < 0.5 ? 0 : 1, y: s.y });
    }
    found.sort((a, b) => a.column - b.column || a.y - b.y);
    for (const f of found) {
      const occurrence = (seen.get(f.position) ?? 0) + 1;
      seen.set(f.position, occurrence);
      out.push({ ...f, occurrence });
    }
  }
  return out;
}

export interface CropRegion {
  page: number;
  /** Normalized 0–1 box, top-left origin. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Body area of a booklet page (header and footer bands excluded). */
const BODY_TOP = 0.06;
const BODY_BOTTOM = 0.95;

/**
 * Crop regions of every marker: from the marker down to the next marker of the same column (or the bottom of the
 * column). When the item runs past the end of its column, the next column (or the next page's first column) is
 * added from its top down to its first marker.
 */
export function cropRegions(markers: readonly QuestionMarker[], pageCount: number): Map<QuestionMarker, CropRegion[]> {
  const out = new Map<QuestionMarker, CropRegion[]>();
  const colBox = (column: 0 | 1) => (column === 0 ? { x0: 0.03, x1: 0.5 } : { x0: 0.5, x1: 0.97 });
  const firstMarkerIn = (page: number, column: 0 | 1) => markers.filter((m) => m.page === page && m.column === column).sort((a, b) => a.y - b.y)[0];
  for (const m of markers) {
    const regions: CropRegion[] = [];
    const sameCol = markers.filter((o) => o.page === m.page && o.column === m.column && o.y > m.y).sort((a, b) => a.y - b.y)[0];
    regions.push({ page: m.page, ...colBox(m.column), y0: Math.max(0, m.y - 0.005), y1: sameCol ? sameCol.y - 0.005 : BODY_BOTTOM });
    if (!sameCol) {
      // Continuation: the right column of the same page, or the left column of the next page.
      const next = m.column === 0 ? { page: m.page, column: 1 as const } : { page: m.page + 1, column: 0 as const };
      if (next.page <= pageCount) {
        const first = firstMarkerIn(next.page, next.column);
        const top = BODY_TOP;
        const bottom = first ? first.y - 0.005 : BODY_BOTTOM;
        if (bottom - top > 0.03) regions.push({ page: next.page, ...colBox(next.column), y0: top, y1: bottom });
      }
    }
    out.set(m, regions);
  }
  return out;
}

/**
 * Matches a booklet marker to the microdata item of that booklet: same CO_PROVA and position; for the LC
 * foreign-language positions the first occurrence is English and the second Spanish.
 */
export function itemForMarker(groups: readonly ItemGroup[], coProvaByArea: Partial<Record<EnemArea, string>>, marker: QuestionMarker): ItemGroup | null {
  const candidates = groups.filter((g) => {
    const code = coProvaByArea[g.area];
    return code !== undefined && g.positions.some((p) => p.co_prova === code && p.position === marker.position);
  });
  if (candidates.length <= 1) return candidates[0] ?? null;
  const wanted = marker.occurrence === 1 ? 'en' : 'es';
  return candidates.find((g) => g.language === wanted) ?? null;
}

/** Position inside the area test (1–45) from a booklet position. */
export function positionInArea(position: number): number {
  return ((position - 1) % 45) + 1;
}
