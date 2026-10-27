import type { CacheTtl, CacheControl, ContentBlock, DocumentBlock, DocumentSource, TextBlock } from './types.ts';
import { formatPageList } from './pages.ts';

export interface PdfSlice {
  /** Id of the stored document (or slice owner). Returned to the caller, never sent to the model. */
  documentId: string;
  title: string;
  /** ORIGINAL page numbers of the pages in this block, in ascending order. */
  pages: readonly number[];
  source: DocumentSource;
}

export interface DocumentBlocks {
  blocks: DocumentBlock[];
  /** doc label (D1, D2, …) → documentId, used to map model output back to storage. */
  labels: Record<string, string>;
  /** doc label → allowed original page numbers, used to validate model output. */
  allowedPages: Record<string, number[]>;
}

export function cacheControl(ttl: CacheTtl | undefined): CacheControl | undefined {
  return ttl ? { type: 'ephemeral', ttl } : undefined;
}

export function text(value: string, ttl?: CacheTtl): TextBlock {
  const cc = cacheControl(ttl);
  return cc ? { type: 'text', text: value, cache_control: cc } : { type: 'text', text: value };
}

/**
 * Document blocks in the order given (callers sort by (documentId, first page)).
 * Labels are assigned by position, so the same inputs always render the same prompt.
 * The last block gets the cache breakpoint when `ttl` is set.
 */
export function documentBlocks(slices: readonly PdfSlice[], ttl?: CacheTtl): DocumentBlocks {
  const labels: Record<string, string> = {};
  const allowedPages: Record<string, number[]> = {};
  const blocks: DocumentBlock[] = slices.map((slice, index) => {
    const label = `D${index + 1}`;
    labels[label] = slice.documentId;
    allowedPages[label] = [...slice.pages];
    const block: DocumentBlock = {
      type: 'document',
      title: `Documento ${label} — ${slice.title} — páginas originais ${formatPageList(slice.pages)}`,
      source: slice.source,
    };
    return block;
  });
  const last = blocks.length - 1;
  if (ttl && last >= 0) {
    const cc = cacheControl(ttl);
    if (cc) blocks[last] = { ...blocks[last]!, cache_control: cc };
  }
  return { blocks, labels, allowedPages };
}

export function imageBlock(data: string, mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg'): ContentBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/** Joins non-empty lines. Keeps prompt text free of accidental blank-line drift. */
export function lines(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

export function section(title: string, body: string): string {
  return `${title}\n${body}`;
}
