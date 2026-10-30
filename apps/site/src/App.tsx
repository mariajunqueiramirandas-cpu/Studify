import { useEffect } from 'react';
import { CodeCard, DownloadButton, Hero, InstallSteps, Page } from './components.tsx';
import { APP_SCHEME } from './config.ts';
import { Landing } from './landing.tsx';
import { linkKindOf, parseSharedLink, type SharedLink } from './links.ts';

function LinkPage({ link }: { link: SharedLink | null }) {
  useEffect(() => {
    document.title = link ? `${link.title} · Studify` : 'Convite do Studify';
  }, [link]);

  return (
    <Page brandHref="/">
      <Hero
        title={link?.title ?? 'Você foi convidado(a) para o Studify'}
        subtitle={link?.subtitle ?? 'O Studify transforma os PDFs das suas aulas em resumos, cartões e quizzes.'}
      />
      {link?.label && <CodeCard label={link.label} code={link.shown} />}
      {link && (
        <a className="key key-primary key-large" href={link.deepLink}>
          Já tenho o app: abrir
        </a>
      )}
      <DownloadButton />
      <InstallSteps withCode />
      <p className="note">Por enquanto o Studify é só para Android.</p>
    </Page>
  );
}

export function App({ pathname }: { pathname: string }) {
  return linkKindOf(pathname) ? <LinkPage link={parseSharedLink(pathname, APP_SCHEME)} /> : <Landing />;
}
