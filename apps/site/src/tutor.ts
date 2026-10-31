// The tutor demo answers only from this page, like the app's tutor answers only from the student's material
// (TUT-01, TUT-04): every answer cites the section it came from, and a question the page does not cover gets
// "isso não está aqui".

/** Section ids of the landing page (landing.tsx). */
export type SectionId = 'como-funciona' | 'cartoes' | 'plano' | 'tutor' | 'recursos' | 'turma' | 'baixar';

export interface Citation {
  section: SectionId;
  /** The section as named on the citation link. */
  label: string;
}

export type TutorAnswer =
  | { kind: 'grounded'; text: string; cite: Citation }
  | { kind: 'missing'; text: string; general?: string };

interface Intent {
  keys: string[];
  answer: TutorAnswer;
}

const SECTION_LABEL: Record<SectionId, string> = {
  'como-funciona': 'Como funciona',
  cartoes: 'Cartões',
  plano: 'Plano',
  tutor: 'Tutor',
  recursos: 'Recursos',
  turma: 'Turma',
  baixar: 'Baixar o app',
};

const cite = (section: SectionId): Citation => ({ section, label: SECTION_LABEL[section] });

const MISSING = 'Isso não está nesta página. Pergunte sobre o Studify, como o plano ou os cartões.';

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
    answer: { kind: 'grounded', text: 'Ainda não. Por enquanto o Studify é só para Android.', cite: cite('baixar') },
  },
  {
    keys: ['turma', 'amig', 'colega', 'classe', 'junto', 'grupo', 'duelo', 'batalha'],
    answer: {
      kind: 'grounded',
      text: 'Dá. Quem organiza a turma manda os PDFs uma vez e todo mundo estuda pelo mesmo material, com duelos e batalha ao vivo.',
      cite: cite('turma'),
    },
  },
  {
    keys: ['err', 'caderno'],
    answer: {
      kind: 'grounded',
      text: 'Eu mostro a certa, explico o porquê e guardo o erro no Caderno de Erros, que vira revisão.',
      cite: cite('recursos'),
    },
  },
  {
    keys: ['enem', 'redacao', 'vestibular'],
    answer: {
      kind: 'grounded',
      text: 'Tem um modo ENEM: as 4 áreas + Redação, simulados com TRI e correção de redação.',
      cite: cite('recursos'),
    },
  },
  {
    keys: ['offline', 'internet', 'wifi'],
    answer: { kind: 'grounded', text: 'Os cartões funcionam sem internet. Quando a conexão volta, eu sincronizo tudo.', cite: cite('recursos') },
  },
  {
    keys: ['plano', 'prova', 'data', 'calendario', 'semana', 'cronograma', 'dia'],
    answer: {
      kind: 'grounded',
      text: 'Você me diz a data da prova e eu divido o conteúdo pelos dias que faltam, com cada revisão marcada pouco antes de você esquecer. Perdeu um dia? Eu reorganizo.',
      cite: cite('plano'),
    },
  },
  {
    keys: ['esquec', 'memoria', 'apag', 'lembr', 'curva', 'fsrs', 'revis', 'cart', 'flashcard'],
    answer: {
      kind: 'grounded',
      text: 'Cada cartão volta pouco antes de você esquecer. Errou, ele volta em minutos; achou fácil, só daqui a dias.',
      cite: cite('cartoes'),
    },
  },
  {
    keys: ['pdf', 'material', 'slide', 'apostila', 'resumo', 'quest', 'quiz', 'como funciona', 'o que'],
    answer: {
      kind: 'grounded',
      text: 'Você manda o material da aula e eu transformo em resumos, cartões e questões. Cada um mostra a página de onde saiu.',
      cite: cite('como-funciona'),
    },
  },
  {
    keys: ['baixar', 'instal', 'download', 'apk', 'android', 'convite', 'celular', 'entrar', 'comecar'],
    answer: {
      kind: 'grounded',
      text: 'Toque em Baixar o app (Android) e siga os passos de instalação. Por enquanto o Studify funciona por convite.',
      cite: cite('baixar'),
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
