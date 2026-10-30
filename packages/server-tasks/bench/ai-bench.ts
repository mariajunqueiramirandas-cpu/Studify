// Runs the real prompts of the main tasks against the Claude API on one PDF and prints, per call, latency, time to
// first token, tokens (thinking included), cache use and output health. Spends real money (Haiku 5.5: cents per run).
//
//   ANTHROPIC_API_KEY=… npx tsx bench/ai-bench.ts <pdf> [task …] [--repeat N]
//
// BENCH_THINKING=adaptive|disabled and BENCH_EFFORT=low|medium|high override what the app sends.
// BENCH_PAGE_OFFSET=N shifts the original page numbers: new page enums mean a new grammar and a cold cache.
// BENCH_DUMP=<dir> writes each output's text, for bench/judge.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { callClaude, type AnthropicLike, type AiUsageRow, type BudgetContext, type ClaudeDeps } from '@studify/ai';
import { getTask } from '@studify/prompts';
import { prepareCall, toPdfSlices, type SliceRef } from '../src/ingest/tasks.ts';

const args = process.argv.slice(2);
const pdfPath = args.shift();
if (!pdfPath) throw new Error('usage: ai-bench.ts <pdf> [task …] [--repeat N]');
const repeatAt = args.indexOf('--repeat');
const repeat = repeatAt >= 0 ? Number(args.splice(repeatAt, 2)[1]) : 1;
const pdf = readFileSync(pdfPath).toString('base64');
const thinking = process.env.BENCH_THINKING || undefined;
const effort = process.env.BENCH_EFFORT || undefined;
const cfg = `${thinking ?? 'default'}-${effort ?? 'app'}`;

const offset = Number(process.env.BENCH_PAGE_OFFSET ?? 0);
const pages = [1, 2, 3, 4, 5, 6, 7].map((p) => p + offset);
const slice: SliceRef = { id: 'slice-1', documentId: 'doc-bio', title: 'Biologia — Apostila', pages, tokenCount: null, source: { kind: 'base64', data: pdf } };
const slices = toPdfSlices([slice]);
const topic = {
  title: 'Respiração celular',
  objectives: ['Explicar a glicólise.', 'Descrever o ciclo de Krebs e a cadeia respiratória.'],
  concepts: [
    { key: 'c1', title: 'Glicólise', keyTerms: ['glicólise', 'piruvato'], formulas: [] },
    { key: 'c2', title: 'Ciclo de Krebs', keyTerms: ['acetil-CoA'], formulas: [] },
    { key: 'c3', title: 'Cadeia respiratória', keyTerms: ['ATP sintase'], formulas: [] },
  ],
};
const language = { contentLanguage: 'pt-BR', languageSubject: false };
const step = { topic: { ...topic, summary: 'Como a célula obtém energia.' }, concept: { key: 'c1', title: 'Glicólise', summary: 'Quebra da glicose no citoplasma.', keyTerms: ['glicólise', 'piruvato'] }, taughtBefore: ['ATP'], slices, ...language };

const INPUTS: Record<string, unknown> = {
  'ingest.outline': { subjectName: 'Biologia', fileName: 'apostila.pdf', slice: slices[0], kindHint: 'notes', existing: [] },
  'ingest.topicDetail': { topic: { key: 't1', title: topic.title, summary: 'Como a célula obtém energia.', objectives: topic.objectives }, siblingTitles: ['Fermentação', 'Fotossíntese'], existingConceptTitles: [], slices, ...language },
  'cards.generate': { topic, slices, existingFronts: [], targetCount: 8, ...language },
  'questions.generate': { topic, slices, quotas: { mcq_single: 4, true_false: 1, fill_blank: 1, short_answer: 1 }, existingStems: [], quantitative: false, focusConceptKeys: ['c1', 'c2'], ...language },
  'feed.generate': { topic, slices, figurePages: [], existingTitles: [], ...language },
  'notes.study': { topic, siblingTitles: ['Fermentação'], hasFormulas: true, slices, ...language },
  'notes.tldr': { topic, slices, ...language },
  'trail.lesson': step,
  'trail.reinforce': { ...step, lesson: { title: 'Glicólise', body: 'A **glicólise** quebra a glicose em dois piruvatos no citoplasma, com saldo de 2 ATP.' }, askedStems: [] },
  'tutor.turn': { mode: 'Responder', modeChanged: false, history: [], newSlices: slices, message: 'Por que o músculo produz ácido lático na corrida?', scope: { kind: 'subject', label: 'Biologia', excludedTopicTitles: [], processingPct: 100 }, socraticAttempts: 0, ...language },
};

type TextBlock = { type: string; text?: string; citations?: unknown[] | null };

const sdk = new Anthropic({ maxRetries: 0, timeout: 600_000 });
const override = <P extends object>(params: P): P => ({
  ...params,
  ...(thinking ? { thinking: { type: thinking } } : {}),
  ...(effort ? { output_config: { ...(params as { output_config?: object }).output_config, effort } } : {}),
});
const client = {
  beta: {
    messages: {
      create: (p: never, o: never) => sdk.beta.messages.create(override(p), o),
      stream: (p: never, o: never) => sdk.beta.messages.stream(override(p), o),
    },
    files: sdk.beta.files,
  },
  messages: sdk.messages,
} as unknown as AnthropicLike;

const rows: AiUsageRow[] = [];
const deps: ClaudeDeps = {
  client,
  budget: { reserve: async () => ({ ok: true, reservationId: 'bench' }), settle: async () => {} },
  usage: { record: async (row) => void rows.push(row) },
  timeoutMs: 600_000,
  maxRetries: 0,
};
const ctx: BudgetContext = { userId: null, classGroupId: null, feature: 'BENCH', budgetClass: 'system' };

const words = (t: string) => t.toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);

/** Cited spans whose uncited lead-in (the text right before, same line) already says the same thing. Heuristic. */
function restated(content: readonly TextBlock[]): string | null {
  const blocks = content.filter((b) => b.type === 'text');
  let cited = 0;
  let repeated = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (!block.citations?.length) continue;
    cited++;
    const prev = blocks[i - 1];
    if (!prev || prev.citations?.length) continue;
    const lead = new Set(words((prev.text ?? '').split('\n').pop() ?? ''));
    const span = new Set(words(block.text ?? ''));
    if (lead.size >= 3 && [...lead].filter((w) => span.has(w)).length / lead.size >= 0.5) repeated++;
  }
  return cited ? `${repeated}/${cited}` : null;
}

const tasks = args.length ? args : Object.keys(INPUTS);
for (let run = 0; run < repeat; run++) {
  for (const id of tasks) {
    const input = INPUTS[id];
    if (!input) {
      console.log(JSON.stringify({ task: id, skipped: 'no bench input' }));
      continue;
    }
    const { call } = prepareCall(id, getTask(id).build(input as never), ctx, [slice]);
    const started = Date.now();
    rows.length = 0;
    try {
      const res = await callClaude(deps, call);
      const row = rows.at(-1);
      const data = res.status === 'ok' && res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null;
      const counts = Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length]));
      console.log(JSON.stringify({
        task: id, run, cfg, status: res.status, ms: Date.now() - started, ttft: row?.ttft_ms,
        in: row?.input_tokens, cacheR: row?.cache_read_tokens, cacheW: row ? row.cache_creation_5m_tokens + row.cache_creation_1h_tokens : null,
        out: row?.output_tokens, think: row?.thinking_tokens, cites: res.citations.length, restated: restated(res.content as TextBlock[]), counts,
        ...('issues' in res ? { issues: res.issues } : {}), usd: (res.costMicroUsd / 1e6).toFixed(5),
      }));
      if (process.env.BENCH_DUMP) writeFileSync(`${process.env.BENCH_DUMP}/${id}-${cfg}-${run}.txt`, res.text);
    } catch (err) {
      console.log(JSON.stringify({ task: id, run, cfg, error: String(err).slice(0, 500), ms: Date.now() - started }));
    }
  }
}
