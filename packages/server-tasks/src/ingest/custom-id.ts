// Batch custom_id encoding (ai-pipeline §7.2, spec 01 §7). The API allows 1–64 characters of [A-Za-z0-9_-]
// and no colons, so the logical key `{node_id}:{kind}:{prompt_version}` is encoded as
// `{node_id without dashes}-{kind code}`. The prompt version is not needed to route a result: the
// task id follows from the kind, and the plan stored in the batch.poll payload carries it for audit.
export type TopicKind = 'concepts' | 'tldr' | 'study' | 'deep' | 'glossary' | 'cards' | 'questions' | 'feed' | 'find_error' | 'problems';

const KIND_CODE: Readonly<Record<TopicKind, string>> = {
  concepts: 'c',
  tldr: 't',
  study: 's',
  deep: 'd',
  glossary: 'g',
  cards: 'k',
  questions: 'q',
  feed: 'f',
  find_error: 'e',
  problems: 'p',
};

const CODE_KIND: Readonly<Record<string, TopicKind>> = Object.fromEntries(
  Object.entries(KIND_CODE).map(([kind, code]) => [code, kind as TopicKind]),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC_ID = /^([0-9a-f]{32})-([a-z])(\d)?$/;
const PAGES_ID = /^p(\d{1,5})-(\d{1,5})$/;

/** `part`: one part of a topic's question bank (0–9), written by its own request. */
export function buildTopicCustomId(nodeId: string, kind: TopicKind, part?: number): string {
  if (!UUID.test(nodeId)) throw new Error(`node id must be a UUID: ${nodeId}`);
  if (part !== undefined && !(Number.isInteger(part) && part >= 0 && part <= 9)) throw new Error(`part must be 0–9: ${part}`);
  return `${nodeId.replace(/-/g, '').toLowerCase()}-${KIND_CODE[kind]}${part ?? ''}`;
}

export function parseTopicCustomId(customId: string): { nodeId: string; kind: TopicKind; part?: number } | null {
  const match = TOPIC_ID.exec(customId);
  if (!match) return null;
  const hex = match[1] ?? '';
  const kind = CODE_KIND[match[2] ?? ''];
  if (!kind) return null;
  const nodeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return match[3] !== undefined ? { nodeId, kind, part: Number(match[3]) } : { nodeId, kind };
}

/** Transcription batches: one request per run of consecutive scanned pages (ingest.transcribePages). */
export function buildPagesCustomId(start: number, end: number): string {
  return `p${start}-${end}`;
}

export function parsePagesCustomId(customId: string): { start: number; end: number } | null {
  const match = PAGES_ID.exec(customId);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end >= start ? { start, end } : null;
}

/** Task id for each topic kind (packages/prompts registry ids). */
export const TASK_FOR_KIND: Readonly<Record<TopicKind, string>> = {
  concepts: 'ingest.topicDetail',
  tldr: 'notes.tldr',
  study: 'notes.study',
  deep: 'notes.deep',
  glossary: 'glossary.define',
  cards: 'cards.generate',
  questions: 'questions.generate',
  feed: 'feed.generate',
  find_error: 'acheOErro.generate',
  problems: 'problems.generate',
};

/** Expands the public kind names used by job payloads (api.md §7) into internal kinds. */
export function expandKinds(kinds: readonly string[]): TopicKind[] {
  const out = new Set<TopicKind>();
  for (const kind of kinds) {
    if (kind === 'notes') {
      out.add('tldr');
      out.add('study');
    } else if (kind in KIND_CODE) {
      out.add(kind as TopicKind);
    }
  }
  return [...out];
}
