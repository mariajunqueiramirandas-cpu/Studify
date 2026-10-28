// Reads a response by block type (never by position) and validates structured output.
// Source: ai-pipeline §2.4 (content read by type), §5.1 (Zod always runs), §5.2 (citation spans).

import type { ZodIssue } from "zod";
import { mapCitation } from "./pdf.ts";
import type {
  BetaContentBlock,
  BetaTextCitation,
  MappedCitation,
  SourceMap,
  TaskDef,
  ToolUse,
} from "./types.ts";

export interface TextSpan {
  start: number;
  end: number;
  citations: BetaTextCitation[];
}

export interface ExtractedContent {
  /** Concatenated text of all text blocks, in order. */
  text: string;
  spans: TextSpan[];
  toolUses: ToolUse[];
}

export function extractContent(content: readonly BetaContentBlock[]): ExtractedContent {
  let text = "";
  const spans: TextSpan[] = [];
  const toolUses: ToolUse[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const start = text.length;
      text += block.text;
      const citations = (block.citations ?? []) as BetaTextCitation[];
      if (citations.length > 0) {
        spans.push({ start, end: text.length, citations });
      }
    } else if (block.type === "tool_use") {
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
    // thinking, redacted_thinking, fallback and server-tool blocks carry no visible text here.
  }
  return { text, spans, toolUses };
}

/** Flattens spans into mapped citations with their text offsets (§5.2). */
export function mapSpanCitations(spans: readonly TextSpan[], sources: SourceMap | undefined): MappedCitation[] {
  const out: MappedCitation[] = [];
  for (const span of spans) {
    for (const citation of span.citations) {
      out.push({ ...mapCitation(citation, sources), textStart: span.start, textEnd: span.end });
    }
  }
  return out;
}

/** Items removed from list outputs because they broke the schema on their own (the rest of the output is kept). */
export interface Salvage {
  dropped: number;
  issues: string;
}

export type ParseResult<T> = { ok: true; data: T; salvage?: Salvage } | { ok: false; issues: string };

/** Rounds of dropping items: removing items can only surface new issues at the list level (too few items). */
const SALVAGE_ROUNDS = 3;

/**
 * Parses the text as JSON and validates it with the task's Zod schema, then runs the optional postValidate check.
 * Code fences are tolerated. When every issue sits inside an item of a top-level list (`items.3.text: too long`),
 * those items are dropped and the rest is validated again, so one bad item costs that item, not the whole call.
 */
export function parseStructured<T>(text: string, task: TaskDef<T>): ParseResult<T> {
  if (task.output.mode !== "structured") {
    return { ok: false, issues: "task does not expect structured output" };
  }
  const trimmed = stripFence(text.trim());
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, issues: "output is not valid JSON" };
  }
  let parsed = task.output.schema.safeParse(json);
  let dropped = 0;
  let droppedIssues = "";
  for (let round = 0; !parsed.success && round < SALVAGE_ROUNDS; round++) {
    const bad = itemIssues(json, parsed.error.issues);
    if (!bad) break;
    if (!droppedIssues) droppedIssues = summarizeIssues(parsed.error.issues);
    json = withoutItems(json as Record<string, unknown>, bad);
    dropped += [...bad.values()].reduce((acc, set) => acc + set.size, 0);
    parsed = task.output.schema.safeParse(json);
  }
  if (!parsed.success) {
    return { ok: false, issues: summarizeIssues(parsed.error.issues) };
  }
  if (task.postValidate) {
    const problem = task.postValidate(parsed.data);
    if (problem) return { ok: false, issues: problem };
  }
  return dropped > 0 ? { ok: true, data: parsed.data, salvage: { dropped, issues: droppedIssues } } : { ok: true, data: parsed.data };
}

/**
 * The items to drop, by top-level list key, when every issue is inside an item (`key.index…`). Null when any issue
 * is elsewhere (a top-level field, or the list itself, like too few items): nothing can be salvaged then.
 */
function itemIssues(json: unknown, issues: readonly ZodIssue[]): Map<string, Set<number>> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const out = new Map<string, Set<number>>();
  for (const issue of issues) {
    const [key, index] = issue.path;
    if (typeof key !== "string" || typeof index !== "number" || !Array.isArray(root[key])) return null;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(index);
  }
  return out.size > 0 ? out : null;
}

function withoutItems(root: Record<string, unknown>, bad: ReadonlyMap<string, ReadonlySet<number>>): Record<string, unknown> {
  const out = { ...root };
  for (const [key, indexes] of bad) {
    out[key] = (root[key] as unknown[]).filter((_, i) => !indexes.has(i));
  }
  return out;
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  return match?.[1] !== undefined ? match[1].trim() : text;
}

function summarizeIssues(issues: readonly ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(raiz)"}: ${i.message}`)
    .join("; ");
}
