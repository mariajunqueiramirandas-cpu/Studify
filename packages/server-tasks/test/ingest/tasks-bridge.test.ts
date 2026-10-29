import { describe, expect, it } from 'vitest';
import { getTask } from '@studify/prompts';
import { aiTask, prepareCall, toDocumentSlices, toPdfSlices, type SliceRef } from '../../src/ingest/tasks.ts';
import { transcriptionRuns } from '../../src/ingest/waves.ts';
import { labelsOfBlocks } from '../../src/ingest/waves.ts';

const DOC = '0190f3a2-7b1c-7d3e-8f00-00000000d0c1';
const ref: SliceRef = { id: 'slice-1', documentId: DOC, title: 'Slides Aula 1', pages: [4, 5, 6], tokenCount: 3000, source: { kind: 'base64', data: 'QUJD' } };

describe('prompts to @studify/ai bridge', () => {
  it('maps structured tasks to their Zod schema and citation tasks to citation mode', () => {
    expect(aiTask('ingest.outline').output.mode).toBe('structured');
    expect(aiTask('notes.tldr').output).toEqual({ mode: 'citations' });
    expect(aiTask('notes.subjectSummary').output).toEqual({ mode: 'plain' });
    expect(aiTask('questions.generate').id).toBe('questions.generate');
  });

  it('builds a TaskCall whose sources follow the document block order', () => {
    const built = getTask('notes.tldr').build({
      topic: { title: 'Organelas', objectives: [], concepts: [] },
      slices: toPdfSlices([ref]),
      contentLanguage: 'pt-BR',
      languageSubject: false,
    });
    const prepared = prepareCall('notes.tldr', built, { userId: null, classGroupId: null, feature: 'LRN-01', budgetClass: 'content' }, [ref]);
    expect(prepared.call.sources).toEqual([
      expect.objectContaining({ id: 'slice-1', documentId: DOC, pages: [4, 5, 6], base64: 'QUJD' }),
    ]);
    expect(prepared.call.system.length).toBeGreaterThan(0);
    expect(prepared.call.system.at(-1)?.cacheTtl).toBe('1h');
    // Citations on every document block (all-or-none, ai-pipeline §5.2).
    const first = (prepared.call.messages[0]?.content as unknown as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({ type: 'document', citations: { enabled: true } });
  });

  it('keeps file-based sources for Files API slices', () => {
    const fileRef: SliceRef = { ...ref, source: { kind: 'file', fileId: 'file_123' } };
    expect(toDocumentSlices([fileRef])[0]).toMatchObject({ anthropicFileId: 'file_123' });
    expect(toPdfSlices([fileRef])[0]?.source).toEqual({ type: 'file', file_id: 'file_123' });
  });

  it('labels blocks D1…Dn in plan order, the same order the prompt uses', () => {
    const labels = labelsOfBlocks([
      { documentId: DOC, pages: [1, 2] },
      { documentId: 'other', pages: [9] },
    ]);
    expect(labels.labels).toEqual({ D1: DOC, D2: 'other' });
    expect(labels.allowedPages.D2).toEqual([9]);
  });
});

describe('transcription runs (ING-02.6)', () => {
  it('cuts consecutive scanned pages into runs of at most 20', () => {
    const pages = [2, 3, 4, ...Array.from({ length: 25 }, (_, i) => 10 + i), 40];
    const runs = transcriptionRuns(pages);
    expect(runs[0]).toEqual({ start: 2, end: 4 });
    expect(runs.slice(1, 3)).toEqual([
      { start: 10, end: 29 },
      { start: 30, end: 34 },
    ]);
    expect(runs.at(-1)).toEqual({ start: 40, end: 40 });
    expect(runs.every((r) => r.end - r.start + 1 <= 20)).toBe(true);
  });
});
