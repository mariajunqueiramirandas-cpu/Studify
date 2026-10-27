// End-to-end ingestion against a real Postgres (migrations applied), the mock Claude server
// (packages/ai/src/mock) and fake storage. Runs the real JobRegistry over the in-memory queue, so retries,
// ai_jobs mirroring and the job modules in src/jobs are all exercised. CI never calls Claude.
//
// Database: TEST_DATABASE_URL (default: studify_test_worker on localhost). Create it with
//   STUDIFY_TEST_DB=studify_test_worker bash supabase/tests/run.sh
// The suite is skipped when the database is not reachable.
import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startMockClaude, type MockClaude, type MockRequest, type MockResponse } from '../../../../packages/ai/src/mock/index.ts';
import { createPool } from '../../src/framework/db.ts';
import { createBudgetStore } from '../../src/framework/budget.ts';
import { createUsageSink } from '../../src/framework/usage.ts';
import { createClaudeDeps, createAnthropicClient } from '../../src/framework/anthropic.ts';
import { createPushService, type ExpoLike, type ExpoPushMessage } from '../../src/framework/push.ts';
import { JobRegistry } from '../../src/framework/registry.ts';
import { builtinJobs } from '../../src/framework/builtin.ts';
import { createLogger } from '../../src/framework/logger.ts';
import { jobs as ingestJobs } from '../../src/jobs/ingest.ts';
import { jobs as contentJobs } from '../../src/jobs/content.ts';
import { jobs as batchJobs } from '../../src/jobs/batch.ts';
import { jobs as filesJobs } from '../../src/jobs/files.ts';
import { FakeObjectStore, InMemoryQueue, fakeSupabase } from './support/fakes.ts';
import { textPdf } from './support/pdf.ts';
import type pg from 'pg';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/studify_test_worker';

async function databaseReady(url: string): Promise<boolean> {
  const pool = createPool(url, 1);
  try {
    const { rows } = await pool.query<{ ok: boolean }>(
      `select to_regclass('public.documents') is not null and to_regclass('public.knowledge_nodes') is not null as ok`,
    );
    return rows[0]?.ok === true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const DB_READY = await databaseReady(DATABASE_URL);

const TOPIC_ORGANELAS = 'Organelas';
const TOPIC_MEMBRANA = 'Membrana';

/** Chooses the canned response for each prompt. Keys come from the task rules text in packages/prompts. */
function respond(req: MockRequest): MockResponse | undefined {
  const body = req.bodyText;
  const topic = body.includes('"title": "Membrana"') ? TOPIC_MEMBRANA : TOPIC_ORGANELAS;
  const isMembrana = topic === TOPIC_MEMBRANA;
  const text = (value: unknown): MockResponse => ({ kind: 'message', message: { text: JSON.stringify(value) } });

  if (body.includes('organize o material em um mapa de conhecimento')) {
    return text({
      is_study_material: true,
      language: 'pt-BR',
      detected_kind: 'slides',
      title_suggestion: 'Biologia celular',
      units: [
        {
          key: 'u1',
          title: 'Célula',
          summary: 'A célula e suas partes.',
          page_start: 1,
          page_end: 3,
          match_existing_node_id: null,
          topics: [
            { key: 't1', title: TOPIC_ORGANELAS, summary: 'Organelas da célula.', learning_objectives: ['Identificar organelas'], page_start: 1, page_end: 2, match_existing_node_id: null },
            { key: 't2', title: TOPIC_MEMBRANA, summary: 'Membrana plasmática.', learning_objectives: ['Explicar a membrana'], page_start: 3, page_end: 3, match_existing_node_id: null },
          ],
        },
      ],
    });
  }
  if (body.includes('identifique os conceitos de um tópico')) {
    return text({
      concepts: [
        isMembrana
          ? { key: 'c1', title: 'Membrana plasmática', summary: 'Controla a passagem de substâncias.', page_start: 3, page_end: 3, key_terms: ['bicamada'], formulas: [] }
          : { key: 'c1', title: 'Mitocôndria', summary: 'Produz ATP.', page_start: 1, page_end: 2, key_terms: ['ATP'], formulas: [] },
      ],
    });
  }
  if (body.includes('indique pré-requisitos reais')) return text({ edges: [] });
  if (body.includes('Tarefa: escreva o Resumo rápido do tópico')) {
    return {
      kind: 'message',
      message: {
        content: [
          {
            type: 'text',
            text: isMembrana ? 'A membrana controla a entrada e a saída de substâncias.' : 'A mitocôndria produz ATP.',
            citations: [{ document_index: 0, start_page_number: 1, end_page_number: 1, cited_text: 'produz ATP' }],
          },
          { type: 'text', text: ' Isso é essencial para a célula.' },
        ],
      },
    };
  }
  if (body.includes('Tarefa: escreva o Resumo do tópico em Markdown')) {
    return {
      kind: 'message',
      message: {
        content: [
          { type: 'text', text: '## Ideia central\n\nA célula depende de organelas.', citations: [{ document_index: 0, start_page_number: 1, end_page_number: 1, cited_text: 'organelas' }] },
          { type: 'text', text: '\n\n## Conexões\n\nVer outros tópicos.' },
        ],
      },
    };
  }
  if (body.includes('escreva o glossário do tópico')) {
    return text({
      terms: [
        isMembrana
          ? { term: 'Bicamada lipídica', definition: 'Camada dupla de lipídios.', example: null, aliases: [], concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 3, page_end: 3 }] }
          : { term: 'ATP', definition: 'Molécula que armazena energia.', example: null, aliases: ['adenosina trifosfato'], concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 1, page_end: 2 }] },
      ],
    });
  }
  if (body.includes('crie cartões de repetição espaçada')) {
    return text({
      cards: [
        isMembrana
          ? { type: 'basic', front: 'O que a membrana plasmática controla?', back: 'A passagem de substâncias', cloze_text: null, concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 3, page_end: 3 }], difficulty_estimate: 2 }
          : { type: 'basic', front: 'Qual organela produz ATP?', back: 'Mitocôndria', cloze_text: null, concept_key: 'c1', source_pages: [{ doc: 'D1', page_start: 1, page_end: 2 }], difficulty_estimate: 1 },
      ],
    });
  }
  if (body.includes('escreva as questões do tópico')) {
    const options = ['A', 'B', 'C', 'D', 'E'].map((id) => ({
      id,
      text: `Alternativa ${id}`,
      rationale: `Justificativa da alternativa ${id}.`,
      misconception_concept_key: null,
    }));
    return text({
      questions: [
        {
          type: 'mcq_single',
          stem: isMembrana ? 'Qual é a função da membrana plasmática?' : 'Qual organela produz ATP?',
          stimulus_md: null,
          explanation: 'A resposta correta é a alternativa C.',
          bloom_level: 'remember',
          difficulty: 2,
          concept_keys: ['c1'],
          source_pages: [{ doc: 'D1', page_start: isMembrana ? 3 : 1, page_end: isMembrana ? 3 : 2 }],
          remediation_card: { front: 'Onde se produz ATP?', back: 'Na mitocôndria.' },
          payload: { options, correct: 'C' },
        },
      ],
    });
  }
  return undefined;
}

function captureExpo(): ExpoLike & { sent: ExpoPushMessage[] } {
  const sent: ExpoPushMessage[] = [];
  return {
    sent,
    chunkPushNotifications: (messages) => [messages],
    async sendPushNotificationsAsync(chunk) {
      sent.push(...chunk);
      return chunk.map((m) => ({ status: 'ok' as const, id: `ticket-${m.to}` }));
    },
    async getPushNotificationReceiptsAsync() {
      return {};
    },
  };
}

describe.skipIf(!DB_READY)('ingest.document end to end (Postgres + mock Claude)', () => {
  let pool: pg.Pool;
  let mock: MockClaude;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL, 4);
    mock = await startMockClaude({ handler: respond, batchPollsBeforeEnd: 2, batchResultOrder: 'reverse' });
  }, 60_000);

  afterAll(async () => {
    await mock?.close();
    await pool?.end();
  });

  async function seed(opts: { budgetLimit?: number } = {}) {
    const userId = randomUUID();
    await pool.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${userId}@teste.invalid`]);
    await pool.query(
      `insert into public.profiles (id, display_name, birth_year, birth_month, privacy_notice_version, privacy_accepted_at)
       values ($1, 'Estudante', 2010, 5, '1', now())`,
      [userId],
    );
    const { rows: subjectRows } = await pool.query<{ id: string }>(
      `insert into public.subjects (owner_profile_id, created_by, name, color, icon)
       values ($1, $1, 'Biologia', '#22aa55', 'leaf') returning id`,
      [userId],
    );
    const subjectId = subjectRows[0]!.id;
    const docId = randomUUID();
    const bytes = await textPdf([
      ['Mitocôndria produz ATP para a célula.', 'Organelas são estruturas internas.'],
      ['Organelas incluem ribossomos e retículo.'],
      ['A membrana plasmática controla a passagem de substâncias.', 'Ela é uma bicamada lipídica.'],
    ]);
    const storagePath = `${subjectId}/${docId}.pdf`;
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await pool.query(
      `insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256, status)
       values ($1, $2, $3, 'Slides Aula 1', 'slides', $4, $5, $6, 'uploaded')`,
      [docId, subjectId, userId, storagePath, bytes.byteLength, checksum],
    );
    await pool.query(`insert into public.push_tokens (user_id, token, device_id) values ($1, $2, 'device-1')`, [userId, `ExponentPushToken[${userId.slice(0, 8)}]`]);
    if (opts.budgetLimit !== undefined) {
      await pool.query(
        `insert into private.ai_budgets (scope_type, scope_id, period_type, period_start, limit_micro_usd)
         values ('user', $1, 'day', (now() at time zone 'America/Sao_Paulo')::date, $2)
         on conflict do nothing`,
        [userId, opts.budgetLimit],
      );
    }
    return { userId, subjectId, docId, storagePath, bytes };
  }

  function runtime(store: FakeObjectStore) {
    const log = createLogger('silent');
    const backend = new InMemoryQueue();
    const expo = captureExpo();
    const now = () => new Date();
    const claude = createClaudeDeps({
      client: createAnthropicClient({ apiKey: 'test-key', baseURL: mock.url, timeoutMs: 60_000 }),
      budget: createBudgetStore(pool),
      usage: createUsageSink(pool, log),
      timeoutMs: 60_000,
      sleep: async () => undefined,
    });
    let registry: JobRegistry | null = null;
    const push = createPushService({
      sql: pool,
      expo,
      now,
      log,
      enqueue: (name, data, opts) => {
        if (!registry) throw new Error('registry not ready');
        return registry.enqueue(name, data, opts);
      },
    });
    registry = new JobRegistry({ backend, pool, supabase: fakeSupabase(store), claude, push, log, now });
    return { backend, registry, expo };
  }

  it('runs S0–S4 for a text PDF and writes the knowledge map, content and usage rows', async () => {
    const store = new FakeObjectStore();
    const { userId, subjectId, docId, storagePath, bytes } = await seed();
    store.put('documents', storagePath, bytes, 'application/pdf');
    const { backend, registry, expo } = runtime(store);
    await registry.register([...ingestJobs, ...contentJobs, ...batchJobs, ...filesJobs, ...builtinJobs(() => push_placeholder(registry))]);
    const requestsBefore = mock.requests.length;

    await registry.enqueue('ingest.document', { document_id: docId, mode: 'full', user_id: userId });
    await backend.drain(4000);
    if (process.env.DEBUG_INT) {
      console.log('SENT', backend.sent.map((s) => s.name), 'PENDING', backend.pending.length);
      console.log('JOBS', (await pool.query(`select type, status, stage, error_code, error_message_key from public.ai_jobs where document_id = $1`, [docId])).rows);
      console.log('DOC', (await pool.query(`select status, error_code from public.documents where id = $1`, [docId])).rows);
      console.log('USAGE', (await pool.query(`select task, count(*) from public.ai_usage where document_id = $1 group by task`, [docId])).rows);
      console.log('NODES', (await pool.query(`select kind, content_status, parent_id is null as root from public.knowledge_nodes where origin_document_id = $1`, [docId])).rows);
      console.log('FAILED', backend.failedJobs);
    }
    expect(backend.failedJobs).toEqual([]);

    const doc = await pool.query<{ status: string; error_code: string | null; page_count: number }>(
      `select status, error_code, page_count from public.documents where id = $1`,
      [docId],
    );
    expect(doc.rows[0]).toMatchObject({ status: 'ready', error_code: null, page_count: 3 });

    const pages = await pool.query<{ n: string }>(`select count(*)::text as n from public.document_pages where document_id = $1 and text_source = 'pdf_text_layer'`, [docId]);
    expect(Number(pages.rows[0]?.n)).toBe(3);

    const nodes = await pool.query<{ kind: string; n: string }>(
      `select kind, count(*)::text as n from public.knowledge_nodes where subject_id = $1 group by kind`,
      [subjectId],
    );
    const byKind = Object.fromEntries(nodes.rows.map((r) => [r.kind, Number(r.n)]));
    expect(byKind).toEqual({ unit: 1, topic: 2, concept: 2 });

    const topicStatus = await pool.query<{ content_status: string }>(
      `select content_status from public.knowledge_nodes where subject_id = $1 and kind = 'topic'`,
      [subjectId],
    );
    expect(topicStatus.rows.map((r) => r.content_status)).toEqual(['ready', 'ready']);

    const cards = await pool.query<{ n: string }>(`select count(*)::text as n from public.cards where subject_id = $1 and origin = 'generated'`, [subjectId]);
    expect(Number(cards.rows[0]?.n)).toBe(2);

    const questions = await pool.query<{ n: string; has_remediation: boolean; options: string }>(
      `select count(*)::text as n, bool_and(payload ? 'remediation_card') as has_remediation, max(jsonb_array_length(payload->'options'))::text as options
         from public.questions where subject_id = $1 and origin = 'generated'`,
      [subjectId],
    );
    expect(Number(questions.rows[0]?.n)).toBe(2);
    expect(questions.rows[0]?.has_remediation).toBe(true);
    expect(questions.rows[0]?.options).toBe('5');

    const glossary = await pool.query<{ n: string }>(`select count(*)::text as n from public.glossary_terms where subject_id = $1`, [subjectId]);
    expect(Number(glossary.rows[0]?.n)).toBe(2);

    const notes = await pool.query<{ depth: string; body: string; citations: unknown[] }>(
      `select depth, body, citations from public.notes where subject_id = $1 order by depth`,
      [subjectId],
    );
    expect(notes.rows.length).toBe(4);
    for (const note of notes.rows) {
      expect(note.body).toMatch(/\[\[cite:\d+\]\]/);
      expect(Array.isArray(note.citations)).toBe(true);
    }

    const usage = await pool.query<{ task: string; batch: boolean; n: string }>(
      `select task, batch, count(*)::text as n from public.ai_usage where document_id = $1 group by task, batch order by task`,
      [docId],
    );
    const tasks = usage.rows.map((r) => r.task);
    expect(tasks).toEqual(expect.arrayContaining(['ingest.outline', 'ingest.topicDetail', 'ingest.prerequisites', 'notes.tldr', 'cards.generate', 'questions.generate']));
    expect(usage.rows.find((r) => r.task === 'ingest.topicDetail')?.batch).toBe(true);
    expect(usage.rows.find((r) => r.task === 'ingest.outline')?.batch).toBe(false);

    const job = await pool.query<{ status: string; stage: string; items_total: number; items_done: number; batch_id: string | null }>(
      `select status, stage, items_total, items_done, batch_id from public.ai_jobs where document_id = $1 and type = 'ingest.document'`,
      [docId],
    );
    expect(job.rows[0]).toMatchObject({ status: 'succeeded', items_total: 2, items_done: 2 });

    expect(store.keysIn('slices')).toContain(`${docId}/1-3.pdf`);
    expect(store.keysIn('page-text').filter((k) => k.startsWith(docId)).length).toBe(3);
    expect(store.keysIn('page-images').some((k) => k === `${docId}/thumbs/1.jpg`)).toBe(true);

    const requests = mock.requests.slice(requestsBefore);
    expect(requests.some((r) => r.path === '/v1/files' && r.method === 'POST')).toBe(true);
    expect(requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/v1/files/'))).toBe(true);
    expect(requests.filter((r) => r.path === '/v1/messages/batches' && r.method === 'POST').length).toBe(2);

    expect(expo.sent.some((m) => m.data.type === 'material_ready')).toBe(true);

    // Re-running a finished document does nothing (idempotent, no duplicate nodes or calls).
    const nodesBefore = await pool.query<{ n: string }>(`select count(*)::text as n from public.knowledge_nodes where subject_id = $1`, [subjectId]);
    const callsBefore = mock.requests.length;
    await registry.enqueue('ingest.document', { document_id: docId, mode: 'resume', user_id: userId });
    await backend.drain(200);
    const nodesAfter = await pool.query<{ n: string }>(`select count(*)::text as n from public.knowledge_nodes where subject_id = $1`, [subjectId]);
    expect(nodesAfter.rows[0]?.n).toBe(nodesBefore.rows[0]?.n);
    expect(mock.requests.length).toBe(callsBefore);
  }, 180_000);

  it('parks the document as waiting_budget when the user day budget is exhausted', async () => {
    const store = new FakeObjectStore();
    const { userId, docId, storagePath, bytes } = await seed({ budgetLimit: 0 });
    store.put('documents', storagePath, bytes, 'application/pdf');
    const { backend, registry } = runtime(store);
    await registry.register([...ingestJobs, ...contentJobs, ...batchJobs, ...filesJobs, ...builtinJobs(() => push_placeholder(registry))]);

    await registry.enqueue('ingest.document', { document_id: docId, mode: 'full', user_id: userId });
    await backend.drain(200);
    const doc = await pool.query<{ status: string; error_code: string | null }>(`select status, error_code from public.documents where id = $1`, [docId]);
    expect(doc.rows[0]).toMatchObject({ status: 'waiting_budget', error_code: null });
    const resume = backend.sentNamed('ingest.document').find((s) => s.data.mode === 'resume');
    expect(resume).toBeDefined();
    expect(resume?.options?.startAfter).toBeInstanceOf(Date);
    expect(backend.failedJobs).toEqual([]);
  }, 120_000);
});

/** Push service stub for the built-in jobs in tests that do not assert on notifications. */
function push_placeholder(registry: JobRegistry) {
  return {
    push: async () => 'sent' as const,
    deliverDeferred: async () => 'sent' as const,
    checkReceipts: async () => 0,
    registry,
  } as unknown as ReturnType<typeof createPushService>;
}
