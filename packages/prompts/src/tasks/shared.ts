import type { DocumentMap, PromptMessage, ContentBlock, ToolDef } from '../types.ts';
import { lines } from '../blocks.ts';

export type { PromptMessage, ContentBlock, ToolDef, DocumentMap };

export interface TopicConceptInput {
  key: string;
  title: string;
  keyTerms?: readonly string[];
  formulas?: readonly { latex: string; description: string }[];
}

export interface TopicInput {
  title: string;
  objectives: readonly string[];
  concepts: readonly TopicConceptInput[];
}

/** Generated study content (notes, cards, questions, glossary, feed): the material's language (ING-05.2). */
export function contentLanguageLines(contentLanguage: string, languageSubject: boolean): string {
  return lines(
    `Idioma do conteúdo gerado (títulos, notas, frases de cartões, enunciados, termos): ${contentLanguage}.`,
    languageSubject
      ? 'Matéria de idioma: explicações e feedback em português do Brasil; exemplos, frases e termos na língua-alvo.'
      : null,
  );
}

/** Explanations, feedback and justifications shown to the student: always PT-BR (ING-05.3, spec 03). */
export function feedbackLanguageLines(contentLanguage: string, languageSubject: boolean): string {
  return lines(
    'Explicações, feedback e justificativas: em português do Brasil.',
    languageSubject || contentLanguage !== 'pt-BR'
      ? `Exemplos, frases e termos do material: na língua do conteúdo (${contentLanguage}).`
      : null,
  );
}

export function userTurn(content: ContentBlock[]): PromptMessage {
  return { role: 'user', content };
}
