import { describe, expect, it } from 'vitest';
import type { PipelineEnv } from '../../src/ingest/env.ts';
import type { PageSpan } from '../../src/ingest/slice-plan.ts';
import { topicSliceRefs } from '../../src/ingest/topics.ts';

/** Just what topicSliceRefs reads: the document record and the slice builder (records the spans it was asked for). */
function stubEnv(pageCount: number) {
  const spans: PageSpan[] = [];
  const doc = { id: 'doc-1', title: 'Apostila', storagePath: 'subj/doc-1.pdf', pageCount };
  const env = {
    documents: new Map([['doc-1', Promise.resolve(doc)]]),
    sources: {
      slice: async (_doc: unknown, span: PageSpan) => {
        spans.push(span);
        const pages = Array.from({ length: span.end - span.start + 1 }, (_, i) => span.start + i);
        return { id: `slice-${span.start}-${span.end}`, documentId: 'doc-1', pages, storagePath: '', bytes: new Uint8Array([1]) };
      },
    },
  } as unknown as PipelineEnv;
  return { env, spans };
}

describe('topicSliceRefs', () => {
  it('sends one page of context on each side and marks the topic pages', async () => {
    const { env } = stubEnv(11);
    const refs = await topicSliceRefs(env, [{ documentId: 'doc-1', pageStart: 2, pageEnd: 3 }]);
    expect(refs.map((r) => ({ pages: r.pages, focus: r.focusPages }))).toEqual([{ pages: [1, 2, 3, 4], focus: [2, 3] }]);
  });

  it('stops at the first and last page of the document', async () => {
    const { env } = stubEnv(11);
    const refs = await topicSliceRefs(env, [{ documentId: 'doc-1', pageStart: 10, pageEnd: 11 }]);
    expect(refs[0]?.pages).toEqual([9, 10, 11]);
    expect(refs[0]?.focusPages).toEqual([10, 11]);
  });

  it('sends a page shared by two spans once', async () => {
    const { env, spans } = stubEnv(20);
    await topicSliceRefs(env, [
      { documentId: 'doc-1', pageStart: 2, pageEnd: 3 },
      { documentId: 'doc-1', pageStart: 5, pageEnd: 6 },
    ]);
    expect(spans).toEqual([{ start: 1, end: 7 }]);
  });

  it('never makes a slice of context pages only when a long topic is split', async () => {
    const { env } = stubEnv(200);
    // Topic 2–60 plus context 1 and 61: a 60-page split would leave page 61 alone, so it joins the slice before.
    const joined = await topicSliceRefs(env, [{ documentId: 'doc-1', pageStart: 2, pageEnd: 60 }]);
    expect(joined.map((r) => [r.pages[0], r.pages[r.pages.length - 1]])).toEqual([[1, 61]]);
    // Topic 2–61 plus context 1 and 62: the second slice holds topic page 61, so the split stays.
    const split = await topicSliceRefs(env, [{ documentId: 'doc-1', pageStart: 2, pageEnd: 61 }]);
    expect(split.map((r) => [r.pages[0], r.pages[r.pages.length - 1]])).toEqual([[1, 60], [61, 62]]);
    expect(split[1]?.focusPages).toEqual([61]);
  });

  it('keeps exact pages when context is off (whole-document checks)', async () => {
    const { env } = stubEnv(11);
    const refs = await topicSliceRefs(env, [{ documentId: 'doc-1', pageStart: 1, pageEnd: 5 }], { context: false });
    expect(refs[0]?.pages).toEqual([1, 2, 3, 4, 5]);
    expect(refs[0]?.focusPages).toBeUndefined();
  });
});
