import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import ptBR from './pt-BR.json';

// copy-pt-br.md: single pt-BR locale at launch; placeholders are written `{name}` as in the
// copy guide, plurals use i18next's `_one` / `_other` suffixes with `count`.
void i18n.use(initReactI18next).init({
  resources: { 'pt-BR': { translation: ptBR } },
  lng: 'pt-BR',
  fallbackLng: 'pt-BR',
  interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
  returnNull: false,
});

export { i18n };
export const t = i18n.t.bind(i18n);
export { useTranslation };

/** Splits "A · B · C" catalog strings into option labels. */
export function options(key: string): string[] {
  return i18n.t(key).split(' · ');
}
