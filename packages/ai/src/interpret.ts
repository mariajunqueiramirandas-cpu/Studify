// Reads a response by block type (never by position) and validates structured output.
// Source: ai-pipeline §2.4 (content read by type), §5.1 (Zod always runs), §5.2 (citation spans).

import type { ZodIssue } from "zod";
import { mapCitation } from "./pdf.ts";
import { fixedListKey, fixedListLength, rawJsonSchema } from "./request.ts";
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
  const raw = rawJsonSchema(task.output.schema);
  json = restoreFixedLists(json, raw, raw);
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

/**
 * Turns the objects that stand for fixed-length lists (toJsonSchema) back into lists, walking the JSON beside the
 * schema it was written against. Anything that does not have that shape is left as is for Zod to judge.
 */
export function restoreFixedLists(value: unknown, node: unknown, root: Record<string, unknown>): unknown {
  if (!node || typeof node !== "object" || value === null || typeof value !== "object") return value;
  let schema = node as Record<string, unknown>;
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    if (!target) return value;
    schema = target;
  }
  const branches = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      const restored = restoreFixedLists(value, branch, root);
      if (restored !== value) return restored;
    }
    return value;
  }
  const length = fixedListLength(schema);
  if (length !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const keys = Array.from({ length }, (_, i) => fixedListKey(i));
    if (Object.keys(object).length !== length || !keys.every((k) => k in object)) return value;
    return keys.map((k) => restoreFixedLists(object[k], schema.items, root));
  }
  if (Array.isArray(value)) {
    return schema.items && typeof schema.items === "object" ? value.map((item) => restoreFixedLists(item, schema.items, root)) : value;
  }
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return value;
  const object = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(properties)) {
    if (!(key in object)) continue;
    const restored = restoreFixedLists(object[key], child, root);
    if (restored !== object[key]) {
      out ??= { ...object };
      out[key] = restored;
    }
  }
  return out ?? value;
}

function resolveRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) return null;
  let at: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!at || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at && typeof at === "object" ? (at as Record<string, unknown>) : null;
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
