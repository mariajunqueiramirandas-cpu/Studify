import { useEffect } from 'react';
import { CodeCard, DownloadButton, Hero, InstallSteps, Page } from './components.tsx';
import { APP_SCHEME } from './config.ts';
import { linkKindOf, parseSharedLink, type SharedLink } from './links.ts';

const FEATURES = [
  { title: 'Resumos e cartões', text: 'Cada PDF vira um resumo e cartões com revisão no tempo certo.' },
  { title: 'Quizzes e simulados', text: 'Questões no estilo da sua prova, com correção explicada.' },
  { title: 'Plano até a prova', text: 'O Studify diz o que estudar em cada dia até a Semana de Provas.' },
];

function Home() {
  return (
    <Page>
      <Hero
        title="Seus PDFs viram resumos, cartões e quizzes."
        subtitle="Mande o material da aula e o Studify monta o plano até a prova, com revisões no tempo certo."
      />
      <DownloadButton />
      <ul className="features">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
      <InstallSteps withCode={false} />
      <p className="note">Por enquanto o Studify é só para Android e funciona por convite.</p>
    </Page>
  );
}

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
        <a className="btn btn-primary" href={link.deepLink}>
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
  return linkKindOf(pathname) ? <LinkPage link={parseSharedLink(pathname, APP_SCHEME)} /> : <Home />;
}
