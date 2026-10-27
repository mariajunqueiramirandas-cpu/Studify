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

export type ParseResult<T> = { ok: true; data: T } | { ok: false; issues: string };

/**
 * Parses the text as JSON and validates it with the task's Zod schema, then runs the optional
 * postValidate check. Code fences are tolerated; anything else off-schema fails.
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
  const parsed = task.output.schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: summarizeIssues(parsed.error.issues) };
  }
  if (task.postValidate) {
    const problem = task.postValidate(parsed.data);
    if (problem) return { ok: false, issues: problem };
  }
  return { ok: true, data: parsed.data };
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
