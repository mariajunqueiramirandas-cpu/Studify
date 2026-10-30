// The tutor on p. 4 answers only from this page, like the app's tutor answers only from the student's material
// (TUT-01, TUT-04): every answer cites a sheet, and a question the page does not cover gets "isso não está aqui".
import type { SheetId } from './page-store.ts';

export interface Citation {
  sheet: SheetId | 'p6';
  /** Element id of the cited passage, highlighted when the chip is tapped. */
  passage: string;
  page: number;
}

export type TutorAnswer =
  | { kind: 'grounded'; text: string; cite: Citation }
  | { kind: 'missing'; text: string; general?: string };

interface Intent {
  keys: string[];
  answer: TutorAnswer;
}

const cite = (page: number, passage: string): Citation => ({ sheet: `p${page}` as Citation['sheet'], passage, page });

const MISSING = 'Isso não está nesta apostila. Pergunte sobre o que está escrito aqui, como o plano ou os cartões.';

// Checked in order: the first intent with a matching key wins.
const INTENTS: Intent[] = [
  {
    keys: ['mongolia', 'capital'],
    answer: {
      kind: 'missing',
      text: 'Isso não está no seu material. Quando a pergunta foge do material, eu aviso em vez de inventar.',
      general: 'Ulan Bator.',
    },
  },
  { keys: ['preco', 'pagar', 'pago', 'gratis', 'custa', 'dinheiro', 'assinatura'], answer: { kind: 'missing', text: MISSING } },
  {
    keys: ['iphone', 'ios', 'apple'],
    answer: { kind: 'grounded', text: 'Ainda não. Por enquanto o Studify é só para Android.', cite: cite(6, 'passagem-android') },
  },
  {
    keys: ['turma', 'amig', 'colega', 'classe', 'junto', 'grupo', 'duelo', 'batalha'],
    answer: {
      kind: 'grounded',
      text: 'Dá. Quem organiza a turma manda os PDFs uma vez e todo mundo estuda pelo mesmo material, com duelos e batalha ao vivo.',
      cite: cite(6, 'passagem-turma'),
    },
  },
  {
    keys: ['err', 'caderno'],
    answer: {
      kind: 'grounded',
      text: 'Eu mostro a certa, explico o porquê e guardo o erro no Caderno de Erros, que vira um cartão pra você revisar.',
      cite: cite(5, 'passagem-erros'),
    },
  },
  {
    keys: ['plano', 'prova', 'data', 'calendario', 'semana', 'cronograma', 'dia'],
    answer: {
      kind: 'grounded',
      text: 'Você me diz a data da prova e eu divido o conteúdo pelos dias que faltam, com cada revisão marcada pouco antes de você esquecer. Perdeu um dia? Eu reorganizo.',
      cite: cite(3, 'passagem-plano'),
    },
  },
  {
    keys: ['esquec', 'memoria', 'apag', 'lembr', 'curva', 'fsrs', 'segundo', 'hora', 'relogio'],
    answer: {
      kind: 'grounded',
      text: 'É assim que a memória funciona: o que a gente lê uma vez só começa a sumir no mesmo dia. Nesta página um segundo vale uma hora, então dá pra ver acontecer.',
      cite: cite(1, 'passagem-memoria'),
    },
  },
  {
    keys: ['pdf', 'material', 'slide', 'apostila', 'resumo', 'cart', 'flashcard', 'quest', 'quiz', 'como funciona', 'o que'],
    answer: {
      kind: 'grounded',
      text: 'Você manda o material da aula e eu transformo em resumos, cartões e questões. Cada um mostra a página de onde saiu.',
      cite: cite(2, 'passagem-material'),
    },
  },
  {
    keys: ['baixar', 'instal', 'download', 'apk', 'android', 'convite', 'celular', 'entrar', 'comecar'],
    answer: {
      kind: 'grounded',
      text: 'Toque em Baixar o app (Android) e siga os passos de instalação. Por enquanto o Studify funciona por convite.',
      cite: cite(6, 'passagem-android'),
    },
  },
];

/** Lowercase, no accents, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function answer(question: string): TutorAnswer {
  const q = ` ${normalize(question)} `;
  const words = q.trim().split(' ');
  const intent = INTENTS.find(({ keys }) => keys.some((k) => (k.includes(' ') ? q.includes(` ${k} `) : words.some((w) => w.startsWith(k)))));
  return intent?.answer ?? { kind: 'missing', text: MISSING };
}

/** The suggestion keys under the chat. */
export const SUGGESTIONS = ['Funciona no iPhone?', 'Dá pra estudar com a turma?', 'E se eu errar uma questão?', 'Qual a capital da Mongólia?'];
