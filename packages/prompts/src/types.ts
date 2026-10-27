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
  source: DocumentSource;
  citations?: { enabled: boolean };
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string };
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | DocumentBlock | ImageBlock;

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  strict: true;
  input_schema: JsonSchema;
}

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
