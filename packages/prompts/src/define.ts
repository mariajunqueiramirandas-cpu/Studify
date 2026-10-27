import { z } from 'zod';
import type {
  BudgetClass,
  BuiltPrompt,
  CacheTtl,
  DocumentMap,
  ContentBlock,
  Effort,
  JsonSchema,
  MaxTokensClass,
  OutputMode,
  PromptMessage,
  RunMode,
  TextBlock,
  ToolDef,
} from './types.ts';

export interface BuildContext {
  /** Default TTL for breakpoints this task places on its own blocks (documents, outline text). */
  ttl: CacheTtl;
}

export interface BuildResult {
  messages: PromptMessage[];
  tools?: ToolDef[];
  documents?: DocumentMap;
}

export type OutputConfig<O> =
  | { mode: 'structured'; schema: z.ZodType<O> }
  | { mode: 'citations' }
  | { mode: 'plain' };

export interface TaskConfig<I, O> {
  id: string;
  version: number;
  features: readonly string[];
  effort: Effort;
  /** Optional per-input effort (e.g. `passo_a_passo` runs at medium, other styles at low). */
  effortFor?: (input: I) => Effort;
  maxTokensClass: MaxTokensClass;
  runs: RunMode;
  budget: BudgetClass;
  output: OutputConfig<O>;
  /** Static system fragments, in fixed order. Never depends on input (cache-friendly). */
  system: readonly string[];
  /** TTL of the system breakpoint. Batch waves use 1h (ai-pipeline §6.2). */
  cache: CacheTtl;
  build: (input: I, ctx: BuildContext) => BuildResult;
}

export interface TaskDef<I, O> {
  readonly id: string;
  readonly version: number;
  readonly promptVersion: string;
  readonly features: readonly string[];
  readonly effort: Effort;
  readonly maxTokensClass: MaxTokensClass;
  readonly runs: RunMode;
  readonly budget: BudgetClass;
  readonly outputMode: OutputMode;
  /** JSON Schema sent as output_config.format; present for structured tasks only. */
  readonly jsonSchema: JsonSchema | undefined;
  readonly systemText: string;
  build(input: I): BuiltPrompt;
  /** Validates model output with the task's Zod schema. Throws ZodError on mismatch. */
  parse(raw: unknown): O;
}

const MAX_BREAKPOINTS = 4;

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema) as JsonSchema;
}

/** Document blocks carry `citations` on every block in citations mode, on none otherwise (all-or-none). */
function normalizeCitations(messages: PromptMessage[], mode: OutputMode): PromptMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message;
    const content: ContentBlock[] = message.content.map((block) => {
      if (block.type !== 'document') return block;
      const { citations: _ignored, ...rest } = block;
      return mode === 'citations' ? { ...rest, citations: { enabled: true } } : rest;
    });
    return { ...message, content };
  });
}

function countBreakpoints(system: TextBlock[], messages: PromptMessage[]): number {
  let count = system.filter((b) => b.cache_control).length;
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    count += message.content.filter((b) => b.cache_control).length;
  }
  return count;
}

export function defineTask<I, O = undefined>(config: TaskConfig<I, O>): TaskDef<I, O> {
  const promptVersion = `${config.id}@v${config.version}`;
  const outputMode = config.output.mode;
  const jsonSchema = config.output.mode === 'structured' ? toJsonSchema(config.output.schema) : undefined;
  const systemText = config.system.join('\n\n');
  const system: TextBlock[] = config.system.map((value, index, all) =>
    index === all.length - 1
      ? { type: 'text', text: value, cache_control: { type: 'ephemeral', ttl: config.cache } }
      : { type: 'text', text: value },
  );

  function build(input: I): BuiltPrompt {
    const result = config.build(input, { ttl: config.cache });
    const messages = normalizeCitations(result.messages, outputMode);
    const breakpoints = countBreakpoints(system, messages);
    if (breakpoints > MAX_BREAKPOINTS) {
      throw new Error(`${promptVersion}: ${breakpoints} cache breakpoints (max ${MAX_BREAKPOINTS})`);
    }
    const built: BuiltPrompt = {
      taskId: config.id,
      promptVersion,
      effort: config.effortFor ? config.effortFor(input) : config.effort,
      maxTokensClass: config.maxTokensClass,
      system,
      messages,
    };
    if (result.tools) built.tools = result.tools;
    if (result.documents) built.documents = result.documents;
    if (jsonSchema) built.outputFormat = { type: 'json_schema', schema: jsonSchema };
    return built;
  }

  function parse(raw: unknown): O {
    if (config.output.mode !== 'structured') {
      throw new Error(`${promptVersion} is not a structured task`);
    }
    return config.output.schema.parse(raw);
  }

  return {
    id: config.id,
    version: config.version,
    promptVersion,
    features: config.features,
    effort: config.effort,
    maxTokensClass: config.maxTokensClass,
    runs: config.runs,
    budget: config.budget,
    outputMode,
    jsonSchema,
    systemText,
    build,
    parse,
  };
}

/** Builds a tool definition with a strict Zod-derived input schema (ai-pipeline §2.2 Tools). */
export function strictTool(name: string, description: string, schema: z.ZodType): ToolDef {
  return { name, description, strict: true, input_schema: toJsonSchema(schema) };
}
