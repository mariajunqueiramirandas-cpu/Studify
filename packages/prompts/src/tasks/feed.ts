import { defineTask } from '../define.ts';
import { documentBlocks, lines, section, text, type PdfSlice } from '../blocks.ts';
import { stableStringify } from '../stable-json.ts';
import { FORMAT, GROUNDING, PTBR_STYLE, SAFETY, UNTRUSTED_DATA } from '../fragments/index.ts';
import { FeedItems } from '../schemas/feed.ts';
import { languageLines, userTurn, type TopicInput } from './shared.ts';
import type { CacheTtl } from '../types.ts';

const FEED_RULES = [
  'Tarefa: escreva itens do Feed de Estudos para um tópico: micro-aulas, perguntas rápidas, diagramas e "Você sabia?".',
  '- Por conceito: 1 micro_lesson e 2 quick_question. Por tópico: 1 ou 2 did_you_know. Um diagram para cada página com figura da lista (até 3).',
  '- micro_lesson: uma ideia. title é um gancho (pergunta ou fato surpreendente). body até 280 caracteres (cerca de 40 palavras), lido em até 15 segundos. formula_latex só se houver uma fórmula essencial.',
  '- quick_question: respondível em 20 segundos. 3 ou 4 alternativas (A, B, C, D) ou verdadeiro e falso como A (Verdadeiro) e B (Falso). rationale de cada alternativa com até 140 caracteres. correct é o id da resposta certa. Mesmas regras de distratores de uma prova: plausíveis, sem "todas as anteriores".',
  '- diagram: figure_page é uma das páginas com figura da lista. caption até 160 caracteres. question é opcional ("O que é isso?").',
  '- did_you_know: até 240 caracteres, ligado a um conceito do material. Se trouxer fato fora do material, external_knowledge = true. Nada sensacional nem inadequado para menores.',
  '- Todo item traz concept_key (da lista) e source_pages (páginas originais). Não repita títulos já existentes.',
  '- Não aponte páginas que não estejam nos blocos enviados.',
].join('\n');

export interface FeedInput {
  topic: TopicInput & { objectives: readonly string[] };
  slices: readonly PdfSlice[];
  /** Original page numbers that contain figures (from document_pages.has_images). */
  figurePages: readonly number[];
  existingTitles: readonly string[];
  contentLanguage: string;
  languageSubject: boolean;
  /** Top-up only: concepts with the least coverage. */
  leastCoveredConceptKeys?: readonly string[];
}

function feedMessages(input: FeedInput, ttl: CacheTtl) {
  const docs = documentBlocks(input.slices, ttl);
  const body = lines(
    section('Tópico (JSON):', stableStringify(input.topic)),
    section('Páginas com figura:', stableStringify(input.figurePages)),
    section('Títulos existentes (não repita):', stableStringify(input.existingTitles)),
    input.leastCoveredConceptKeys?.length
      ? section('Reforço: conceitos menos cobertos (priorize):', stableStringify(input.leastCoveredConceptKeys))
      : null,
    languageLines(input.contentLanguage, input.languageSubject),
    'Retorne apenas o objeto estruturado pedido.',
  );
  return { messages: [userTurn([...docs.blocks, text(body)])], documents: { labels: docs.labels, allowedPages: docs.allowedPages } };
}

export const feedGenerate = defineTask<FeedInput, ReturnType<typeof FeedItems.parse>>({
  id: 'feed.generate',
  version: 1,
  features: ['FED-01'],
  effort: 'medium',
  maxTokensClass: 'L',
  runs: 'batch',
  budget: 'content',
  output: { mode: 'structured', schema: FeedItems },
  system: [SAFETY, UNTRUSTED_DATA, PTBR_STYLE, GROUNDING, FORMAT, FEED_RULES],
  cache: '1h',
  build: (input, ctx) => feedMessages(input, ctx.ttl),
});

export const feedTopUp = defineTask<FeedInput, ReturnType<typeof FeedItems.parse>>({
  id: 'feed.topUp',
  version: 1,
  features: ['FED-01.18'],
  effort: 'medium',
  maxTokensClass: 'L',
  runs: 'batch',
  budget: 'content',
  output: { mode: 'structured', schema: FeedItems },
  system: [SAFETY, UNTRUSTED_DATA, PTBR_STYLE, GROUNDING, FORMAT, FEED_RULES],
  cache: '1h',
  build: (input, ctx) => feedMessages(input, ctx.ttl),
});
