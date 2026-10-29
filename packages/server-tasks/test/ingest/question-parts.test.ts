import { describe, expect, it } from 'vitest';
import { topicQuotas } from '@studify/prompts';
import type { Sql } from '../../src/framework/db.ts';
import { missingQuestionParts, questionParts, topicQuestionParts, type TopicBundle } from '../../src/ingest/topics.ts';

// A topic's question bank is written in parallel parts (one ~20k-token call took 60–85 s and was the last thing a
// material waited on): the parts split the quotas and the concepts, and a retry writes only the missing parts.

const concept = (n: number, formulas: unknown[] = []) => ({ key: `C${n}`, title: `Conceito ${n}`, formulas });
const total = (q: Record<string, number | undefined>) => Object.values(q).reduce<number>((a, b) => a + (b ?? 0), 0);

describe('question bank parts', () => {
  it('splits the quotas and the concepts of a topic into three balanced parts', () => {
    const quotas = topicQuotas({ quantitative: false });
    const parts = questionParts({ concepts: [1, 2, 3, 4].map((n) => concept(n)) } as unknown as TopicBundle, quotas);
    expect(parts).toHaveLength(3);
    // Every slot of every type is asked once, by exactly one part.
    for (const [type, n] of Object.entries(quotas)) expect(parts.reduce((a, p) => a + (p.quotas[type as keyof typeof quotas] ?? 0), 0)).toBe(n);
    const sizes = parts.map((p) => total(p.quotas));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    // The heavy multiple choices are spread too, so no part is much longer to write.
    const mcq = parts.map((p) => p.quotas.mcq_single ?? 0);
    expect(Math.max(...mcq) - Math.min(...mcq)).toBeLessThanOrEqual(1);
    // Concepts dealt in map order, each to one part.
    expect(parts.map((p) => p.focusConceptKeys)).toEqual([['C1', 'C4'], ['C2'], ['C3']]);
  });

  it('writes one part per concept below three, and the whole bank at once without concepts to split', () => {
    const quotas = topicQuotas({ quantitative: false });
    expect(questionParts({ concepts: [concept(1), concept(2)] } as unknown as TopicBundle, quotas)).toHaveLength(2);
    expect(questionParts({ concepts: [concept(1)] } as unknown as TopicBundle, quotas)).toEqual([{ index: 0, of: 1, quotas, focusConceptKeys: [] }]);
    expect(questionParts({ concepts: [] } as unknown as TopicBundle, quotas)).toHaveLength(1);
  });

  it('keeps the quantitative quotas (numeric questions) for a topic with formulas', () => {
    const parts = topicQuestionParts({ concepts: [concept(1, [{ latex: 'v = d/t' }]), concept(2), concept(3)] } as unknown as TopicBundle);
    expect(parts.reduce((a, p) => a + (p.quotas.numeric ?? 0), 0)).toBe(topicQuotas({ quantitative: true }).numeric);
  });
});

describe('missing question parts', () => {
  const bundle = {
    topicId: 'topic-1',
    concepts: [1, 2, 3].map((n) => concept(n)),
    conceptIdByKey: new Map([['C1', 'id-1'], ['C2', 'id-2'], ['C3', 'id-3']]),
  } as unknown as TopicBundle;
  const sqlWith = (rows: Array<{ concept_ids: string[] | null }>) => ({ query: async () => ({ rows }) }) as unknown as Sql;

  it('asks for every part of a topic without questions, and for none when every part is written', async () => {
    expect(await missingQuestionParts(sqlWith([]), bundle)).toEqual([0, 1, 2]);
    expect(await missingQuestionParts(sqlWith([{ concept_ids: ['id-1'] }, { concept_ids: ['id-2'] }, { concept_ids: ['id-3', 'id-1'] }]), bundle)).toEqual([]);
  });

  it('asks again only for the part whose concepts no question covers (a part that failed)', async () => {
    expect(await missingQuestionParts(sqlWith([{ concept_ids: ['id-1'] }, { concept_ids: ['id-3'] }, { concept_ids: null }]), bundle)).toEqual([1]);
  });
});

describe('question bank requests', () => {
  it('builds one request per part, each with its own id, share of the quotas and concepts', async () => {
    const { topicItems } = await import('../../src/ingest/waves.ts');
    const bundle = {
      topicId: '0190f3a2-7b1c-7d3e-8f00-00000000abcd',
      subjectId: 'subject-1',
      title: 'Células',
      summary: null,
      objectives: [],
      concepts: [1, 2, 3].map((n) => ({ ...concept(n), id: `id-${n}`, keyTerms: [] })),
      conceptIdByKey: new Map([['C1', 'id-1'], ['C2', 'id-2'], ['C3', 'id-3']]),
      subject: { ownerClassGroupId: null, isLanguageSubject: false },
    } as unknown as TopicBundle;
    const env = { ctx: { db: { query: async () => ({ rows: [] }) } } } as unknown as Parameters<typeof topicItems>[0];
    const refs = [{ id: 's1', documentId: 'doc-1', title: 'Doc', pages: [1, 2], tokenCount: null, source: { kind: 'base64' as const, data: 'JVBERi0=' } }];
    const opts = { jobId: null, userId: null, documentId: 'doc-1', genBatchId: '0190f3a2-7b1c-7d3e-8f00-0000000000aa', force: false, language: 'pt-BR' };
    const items = await topicItems(env, bundle, 'questions', refs, opts);
    expect(items.map((i) => i.item.part)).toEqual([0, 1, 2]);
    expect(new Set(items.map((i) => i.item.customId)).size).toBe(3);
    const prompts = items.map((i) => JSON.stringify(i.call.messages));
    expect(prompts[0]).toContain('cubra só os conceitos C1');
    expect(prompts[2]).toContain('cubra só os conceitos C3');
    // Only the parts asked for (a retry of the missing ones).
    expect((await topicItems(env, bundle, 'questions', refs, opts, [1])).map((i) => i.item.part)).toEqual([1]);
    // Other kinds stay one request.
    expect(await topicItems(env, bundle, 'cards', refs, opts)).toHaveLength(1);
  });
});
