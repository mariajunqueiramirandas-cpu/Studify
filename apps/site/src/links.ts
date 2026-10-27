// Shared-link routes /c/{code}, /i/{code}, /q/{token}, /b/{pin} (SOC-09.4, S-EXT-03). The page only shows when
// Android App Links did not open the app: the app is missing or the link was opened elsewhere.

export type LinkKind = 'c' | 'i' | 'q' | 'b';

export interface SharedLink {
  kind: LinkKind;
  title: string;
  subtitle: string;
  /** Label above the code card; null hides the card (quiz tokens are not meant to be typed). */
  label: string | null;
  /** The value as shown and copied (codes grouped as ABCD-EFGH). */
  shown: string;
  /** Custom-scheme link for "Já tenho o app: abrir" (same targets as the app's App Links, mobile-app.md §2.3). */
  deepLink: string;
}

interface Route {
  title: string;
  subtitle: string;
  label: string | null;
  format: (value: string) => string;
  path: (value: string) => string;
}

const groupCode = (value: string): string => value.toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');

const ROUTES: Record<LinkKind, Route> = {
  c: {
    title: 'Você foi convidado(a) para uma Turma',
    subtitle: 'Estude junto com a sua turma no Studify: materiais, quizzes e duelos.',
    label: 'Código da Turma',
    format: groupCode,
    path: (v) => `class/join?code=${encodeURIComponent(v.toUpperCase())}`,
  },
  i: {
    title: 'Você ganhou um convite para o Studify',
    subtitle: 'O Studify transforma os PDFs das suas aulas em resumos, cartões e quizzes.',
    label: 'Código de convite',
    format: groupCode,
    path: (v) => `auth/invite?code=${encodeURIComponent(v.toUpperCase())}`,
  },
  q: {
    title: 'Te desafiaram para um quiz!',
    subtitle: 'Abra no Studify para responder e comparar o resultado.',
    label: null,
    format: (v) => v,
    path: (v) => `quiz/shared/${encodeURIComponent(v)}`,
  },
  b: {
    title: 'Entre na batalha ao vivo',
    subtitle: 'Abra o Studify e use o PIN para entrar na sala.',
    label: 'PIN da batalha',
    format: (v) => v,
    path: (v) => `class/battle/join?pin=${encodeURIComponent(v)}`,
  },
};

/** The link kind when the path is one of the shared-link routes, else null (the landing page). */
export function linkKindOf(pathname: string): LinkKind | null {
  const first = pathname.split('/').filter(Boolean)[0];
  return first !== undefined && Object.hasOwn(ROUTES, first) ? (first as LinkKind) : null;
}

/** Reads a shared link from the path; null when it is not a link route or carries no value. */
export function parseSharedLink(pathname: string, scheme: string): SharedLink | null {
  const kind = linkKindOf(pathname);
  if (!kind) return null;
  const raw = pathname.split('/').filter(Boolean)[1] ?? '';
  let value: string;
  try {
    value = decodeURIComponent(raw).trim();
  } catch {
    value = raw.trim();
  }
  if (!value) return null;
  const route = ROUTES[kind];
  return {
    kind,
    title: route.title,
    subtitle: route.subtitle,
    label: route.label,
    shown: route.format(value),
    deepLink: `${scheme}://${route.path(value)}`,
  };
}
