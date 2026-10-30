// Blind judge: for each task/run, grades the outputs of every config against the PDF with Claude Opus 5.5.
// Usage: ANTHROPIC_API_KEY=... npx tsx bench/judge.ts <pdf> <dump dir>
import { readFileSync, readdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { getTask } from '@studify/prompts';

const [pdfPath, dir] = process.argv.slice(2) as [string, string];
const pdf = readFileSync(pdfPath).toString('base64');
const client = new Anthropic();
const files = readdirSync(dir);
const groups = new Map<string, Array<{ cfg: string; text: string }>>();
for (const f of files) {
  const m = /^(.+?)-(default|disabled|adaptive)-(app|low|medium|high)-(\d+)\.txt$/.exec(f);
  if (!m) continue;
  const key = `${m[1]}#${m[4]}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push({ cfg: `${m[2]}/${m[3]}`, text: readFileSync(`${dir}/${f}`, 'utf8') });
}
const schema = {
  type: 'object',
  properties: {
    grades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          factual_errors: { type: 'array', items: { type: 'string' } },
          score: { type: 'integer', description: '1 a 10' },
          notes: { type: 'string' },
        },
        required: ['label', 'factual_errors', 'score', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['grades'],
  additionalProperties: false,
};
const totals = new Map<string, { score: number; errors: number; n: number }>();
const jobs = [...groups.entries()].map(async ([key, outs]) => {
  const task = key.split('#')[0]!;
  const shuffled = [...outs].sort(() => Math.random() - 0.5);
  const labels = shuffled.map((_, i) => String.fromCharCode(65 + i));
  const def = getTask(task);
  const prompt = [
    `Você avalia saídas de um app de estudos para alunos do ensino médio. A tarefa "${task}" recebeu o PDF anexo (páginas 1–7) e estas regras de sistema:`,
    '<regras>', def.systemText.slice(-3000), '</regras>',
    'Abaixo estão saídas de configurações diferentes, em ordem aleatória. Para cada uma, liste erros factuais em relação ao material (ou à biologia correta), e dê uma nota de 1 a 10 considerando: correção, fidelidade ao material, utilidade pedagógica, clareza em PT-BR, e se cumpre o que a tarefa pede. Seja rigoroso e consistente entre as saídas.',
    ...shuffled.map((o, i) => `<saida label="${labels[i]}">\n${o.text.slice(0, 30000)}\n</saida>`),
  ].join('\n');
  const msg = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }, { type: 'text', text: prompt }] }],
  } as never);
  const text = (msg as { content: Array<{ type: string; text?: string }> }).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const { grades } = JSON.parse(text) as { grades: Array<{ label: string; factual_errors: string[]; score: number; notes: string }> };
  for (const g of grades) {
    const cfg = shuffled[labels.indexOf(g.label)]!.cfg;
    const k = `${task}|${cfg}`;
    const t = totals.get(k) ?? { score: 0, errors: 0, n: 0 };
    t.score += g.score; t.errors += g.factual_errors.length; t.n++;
    totals.set(k, t);
    console.error(`${key} ${cfg} score=${g.score} errors=${JSON.stringify(g.factual_errors)} ${g.notes.slice(0, 200)}`);
  }
});
await Promise.all(jobs);
const byCfg = new Map<string, { score: number; errors: number; n: number }>();
for (const [k, t] of [...totals.entries()].sort()) {
  console.log(`${k.padEnd(40)} score=${(t.score / t.n).toFixed(1)} errors/output=${(t.errors / t.n).toFixed(2)}`);
  const cfg = k.split('|')[1]!;
  const c = byCfg.get(cfg) ?? { score: 0, errors: 0, n: 0 };
  c.score += t.score; c.errors += t.errors; c.n += t.n; byCfg.set(cfg, c);
}
for (const [cfg, c] of byCfg) console.log(`ALL ${cfg.padEnd(20)} score=${(c.score / c.n).toFixed(2)} errors/output=${(c.errors / c.n).toFixed(2)} n=${c.n}`);
