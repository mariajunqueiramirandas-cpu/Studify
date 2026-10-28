import type { CacheTtl, CacheControl, ContentBlock, DocumentBlock, DocumentSource, TextBlock } from './types.ts';
import { formatPageList } from './pages.ts';

export interface PdfSlice {
  /** Id of the stored document (or slice owner). Returned to the caller, never sent to the model. */
  documentId: string;
  title: string;
  /** ORIGINAL page numbers of the pages in this block, in ascending order. */
  pages: readonly number[];
  /**
   * The pages that belong to the topic, when the block also carries neighboring pages as context
   * (withContextPages). Absent: every page belongs to the task.
   */
  focusPages?: readonly number[];
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
    const focus = slice.focusPages ? slice.pages.filter((p) => slice.focusPages!.includes(p)) : [];
    const context = slice.focusPages ? slice.pages.filter((p) => !slice.focusPages!.includes(p)) : [];
    const pages = formatPageList(slice.pages);
    const block: DocumentBlock = {
      type: 'document',
      title:
        focus.length > 0 && context.length > 0
          ? `Documento ${label} — ${slice.title} — páginas originais ${pages} (do tópico: ${formatPageList(focus)})`
          : `Documento ${label} — ${slice.title} — páginas originais ${pages}`,
      ...(focus.length > 0 && context.length > 0 ? { context: contextPagesNote(focus, context) } : {}),
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

/**
 * What the model may take from the context pages of a topic slice: only the continuation of something the topic's
 * own pages start or finish (a passage cut by the page break, an exercise and its answer), never new subject matter.
 */
export function contextPagesNote(focus: readonly number[], context: readonly number[]): string {
  return lines(
    `O conteúdo deste tópico está nas páginas ${formatPageList(focus)}.`,
    `${context.length === 1 ? 'A página' : 'As páginas'} ${formatPageList(context)} ${context.length === 1 ? 'vem' : 'vêm'} de partes vizinhas do material e ${context.length === 1 ? 'está' : 'estão'} aqui só como contexto, porque um assunto pode começar antes ou terminar depois da quebra de página.`,
    'Use as páginas de contexto apenas para completar um trecho, explicação, tabela ou exercício que começa ou termina nas páginas do tópico.',
    'Não crie conceitos, notas, cartões ou questões sobre assuntos que aparecem só nas páginas de contexto: eles pertencem a outros tópicos.',
    'Ao citar, prefira as páginas do tópico; cite uma página de contexto só para a parte que continua nela.',
  );
}

export function imageBlock(data: string, mediaType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg'): ContentBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/** Joins non-empty lines. Keeps prompt text free of accidental blank-line drift. */
export function lines(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

export function section(title: string, body: string): string {
  return `${title}\n${body}`;
}
