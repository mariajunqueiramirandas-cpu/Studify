// The dashboard follows the theme chosen in the app (profiles.settings.theme): Automático, Claro or Escuro.
// The last choice is remembered on this device so the sign-in page opens in it too.

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'studify-painel-theme';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked (private window): the theme still applies for this visit.
  }
}

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
