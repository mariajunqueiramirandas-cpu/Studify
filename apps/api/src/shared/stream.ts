// Pumps one streamed AI call into SSE events (api §2.6): text → delta, citation → citation (original page
// numbers), tool calls → tool, and a final done with the stop reason and today's budget share.
import type { CallResult, MappedCitation, StreamEvent } from '@studify/ai';
import type { SseWriter } from './sse.ts';
import { nextEvent, type OpenedStream } from './ai.ts';

export interface PumpOptions {
  /** Applied to every text delta before it is sent (for example, stripping the [[APOIO]] marker). */
  transform?: (text: string) => string;
}

export interface PumpResult<T> {
  result: CallResult<T>;
  /** Visible text length sent so far, the offset base for citation events. */
  offset: number;
}

/** Forwards the stream until `end`. Citations arrive with approximate offsets; the final list comes in `done`. */
export async function pumpStream<T>(writer: SseWriter, session: OpenedStream<T>, options: PumpOptions = {}): Promise<PumpResult<T>> {
  let offset = 0;
  let index = 0;
  const handle = (event: StreamEvent) => {
    if (event.type === 'text') {
      const text = options.transform ? options.transform(event.text) : event.text;
      if (text.length > 0) writer.send('delta', { text });
      offset += event.text.length;
    } else if (event.type === 'citation') {
      const c: MappedCitation = event.citation;
      if (!c.valid || c.pageStart === null || c.pageEnd === null || c.documentId === null) return;
      writer.send('citation', {
        start: offset,
        end: offset,
        document_id: c.documentId,
        page_start: c.pageStart,
        page_end: c.pageEnd,
        cited_text: c.citedText,
        index: index++,
      });
    }
  };
  let current: StreamEvent | null = session.first;
  while (current && current.type !== 'end') {
    handle(current);
    current = await nextEvent(session);
  }
  return { result: await session.result, offset };
}

/** done.stop_reason from the classified result (api §2.6). A refusal ends the stream as `refusal`. */
export function stopReasonOf(status: CallResult<unknown>['status']): 'end_turn' | 'max_tokens' | 'refusal' {
  if (status === 'refused') return 'refusal';
  if (status === 'truncated') return 'max_tokens';
  return 'end_turn';
}
