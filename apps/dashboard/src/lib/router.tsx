// A small history router for the dashboard: every page lives under /painel and the API serves index.html for all
// of them. Links are real <a href> elements, so opening in a new tab and copying a link work as usual.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

export const BASE = '/painel';
const EVENT = 'studify:navigate';

/** The path inside the dashboard: '/' for /painel, '/perfil' for /painel/perfil. */
export function innerPath(pathname: string): string {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return '/';
  const rest = pathname.slice(BASE.length).replace(/\/+$/, '');
  return rest === '' ? '/' : rest;
}

export function href(to: string): string {
  return to === '/' ? `${BASE}/` : `${BASE}${to}`;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(EVENT, callback);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => innerPath(window.location.pathname), () => '/');
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = href(to);
  if (url === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo({ top: 0 });
}

/** Matches '/admin/usuarios/:id' against a path; returns the params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const h = have[i]!;
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(h);
    else if (w !== h) return null;
  }
  return params;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children: ReactNode };

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={href(to)} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
