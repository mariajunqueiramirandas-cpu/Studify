// Local types for prompt building. Deliberately independent of @anthropic-ai/sdk
// and @studify/shared: the builders only produce plain request fragments.

export type Effort = 'low' | 'medium' | 'high';
export type MaxTokensClass = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type BudgetClass = 'content' | 'user' | 'system';
export type RunMode = 'edge' | 'edge_stream' | 'worker' | 'worker_stream' | 'batch';
export type CacheTtl = '5m' | '1h';
export type OutputMode = 'structured' | 'citations' | 'plain';

export interface CacheControl {
  type: 'ephemeral';
  ttl: CacheTtl;
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export type DocumentSource =
  | { type: 'base64'; media_type: 'application/pdf'; data: string }
  | { type: 'file'; file_id: string };

export interface DocumentBlock {
  type: 'document';
  title: string;
  /** Notes about the document the model reads but never cites (Messages API `context`). */
  context?: string;
  source: DocumentSource;
  citations?: { enabled: boolean };
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | DocumentBlock | ImageBlock;

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

/** A client tool the model calls with a strict JSON input (ai-pipeline §2.2 Tools). */
export interface CustomToolDef {
  name: string;
  description: string;
  strict: true;
  input_schema: JsonSchema;
}

/**
 * A server tool run by the API (ai-pipeline §12): code execution (CAM-02.6, PRA-08) and web search
 * (ENM-09, ENM-05.5). Results come back as server tool result blocks; usage is billed per tool.
 */
export interface ServerToolDef {
  type: string;
  name: string;
  max_uses?: number;
  allowed_domains?: string[];
}

export type ToolDef = CustomToolDef | ServerToolDef;

export interface DocumentMap {
  /** doc label (D1, D2…) → stored document id. */
  labels: Record<string, string>;
  /** doc label → original page numbers that were sent. */
  allowedPages: Record<string, number[]>;
}

export interface BuiltPrompt {
  taskId: string;
  promptVersion: string;
  /** Per-task hint only; the request sends the owner-policy effort (@studify/ai effortFor). */
  effort: Effort;
  maxTokensClass: MaxTokensClass;
  system: TextBlock[];
  messages: PromptMessage[];
  tools?: ToolDef[];
  outputFormat?: { type: 'json_schema'; schema: JsonSchema };
  /** Present when the prompt carries document blocks. */
  documents?: DocumentMap;
}
