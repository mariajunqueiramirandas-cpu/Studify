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

export function languageLines(contentLanguage: string, languageSubject: boolean): string {
  return lines(
    `Idioma do conteúdo: ${contentLanguage}.`,
    languageSubject
      ? 'Matéria de idioma: explicações e feedback em português do Brasil; exemplos, frases e termos na língua-alvo.'
      : 'Escreva o conteúdo no idioma do conteúdo.',
  );
}

export function userTurn(content: ContentBlock[]): PromptMessage {
  return { role: 'user', content };
}
