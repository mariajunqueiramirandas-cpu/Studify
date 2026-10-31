// The landing page: one page that scrolls, like any other. What makes it Studify is what is on it: study objects
// (the teacher's page, an index card, a calendar leaf), the highlighter, Capi, and demos of the app that work.
import capiCelebrating from './assets/capi-celebrating.webp';
import capiFocused from './assets/capi-focused.webp';
import { DownloadButton, InstallSteps, SiteFooter, SiteHeader } from './components.tsx';
import { Flashcard, PlanChart, Tutor } from './widgets.tsx';

/** A word under the lamp-yellow highlighter, the app's mark for what you must remember. */
function Hl({ children }: { children: string }) {
  return <mark className="hl">{children}</mark>;
}

/** The hero picture: the class material on the left, what Studify makes of it on top. Decorative. */
function HeroArt() {
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="art-page">
        <span className="art-page-head">
          <b>Biologia</b> · Transporte pela membrana
        </span>
        <p>
          <b>Osmose:</b> passagem de água através de uma membrana semipermeável, do meio hipotônico para o meio
          hipertônico.
        </p>
        <span className="art-lines">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="art-folio">12</span>
      </div>
      <div className="art-card">
        <span className="art-card-head">
          <span className="ribbon" />
          Biologia
        </span>
        <p>Na osmose, a água passa pra qual meio?</p>
        <span className="art-card-src">p. 12</span>
      </div>
      <div className="art-quiz">
        <span className="art-quiz-q">Hipertônico é o meio…</span>
        <span className="art-opt">A · menos concentrado</span>
        <span className="art-opt art-opt-right">B · mais concentrado ✓</span>
      </div>
      <div className="leaf art-leaf">
        <span className="leaf-top">prova</span>
        <span className="leaf-num">12</span>
        <span className="leaf-foot">dias</span>
      </div>
      <img className="art-capi" src={capiFocused} alt="" width={180} height={180} />
    </div>
  );
}

const STEPS = [
  {
    title: 'Mande o material',
    text: 'Slides do professor(a), apostila, anotações, prova antiga. Em PDF, do jeito que você recebeu.',
  },
  {
    title: 'Receba o estudo pronto',
    text: 'Eu leio tudo e faço resumos, cartões e questões. Cada um mostra a página de onde saiu.',
  },
  {
    title: 'Siga o plano até a prova',
    text: 'Diga a data. Eu divido o conteúdo pelos dias que faltam e marco cada revisão na hora certa.',
  },
];

const MORE = [
  { title: 'Quizzes e simulados', text: 'Questões do seu material, do treino rápido ao simulado com tempo.' },
  { title: 'Caderno de Erros', text: 'Cada erro fica guardado com o motivo e vira revisão.' },
  { title: 'Semana de Provas', text: 'Várias matérias, cada uma com sua data. O plano equilibra todas.' },
  { title: 'Modo Véspera', text: 'Na noite antes da prova, uma revisão leve e cama cedo.' },
  { title: 'ENEM', text: 'As 4 áreas + Redação, simulados com TRI e correção de redação.' },
  { title: 'Funciona offline', text: 'Revise os cartões sem internet. Eu sincronizo quando a conexão voltar.' },
];

export function Landing() {
  return (
    <div className="site">
      <a className="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <SiteHeader landing />

      <main id="conteudo">
        <section className="hero">
          <div className="wrap hero-in">
            <div className="hero-copy">
              <p className="eyebrow">Para a Semana de Provas e o ENEM</p>
              <h1 className="h1">
                Mande o PDF da aula. Receba o <Hl>estudo pronto.</Hl>
              </h1>
              <p className="lead">
                O Studify transforma o material das suas aulas em resumos, cartões e questões, e monta um plano até o
                dia da prova. Cada resposta mostra a página de onde saiu.
              </p>
              <div className="hero-actions">
                <DownloadButton />
                <a className="key key-large key-ghost" href="#como-funciona">
                  Ver como funciona
                </a>
              </div>
              <p className="note">Só para Android, por enquanto. Funciona por convite.</p>
            </div>
            <HeroArt />
          </div>
        </section>

        <section id="como-funciona" className="section" aria-labelledby="como-funciona-t">
          <div className="wrap">
            <p className="eyebrow">Como funciona</p>
            <h2 id="como-funciona-t" className="h2">
              Do PDF à prova em três passos.
            </h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className="step">
                  <span className="step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="cartoes" className="section section-tint" aria-labelledby="cartoes-t">
          <div className="wrap feature">
            <div className="feature-copy">
              <p className="eyebrow">Cartões</p>
              <h2 id="cartoes-t" className="h2">
                Cada cartão volta <Hl>pouco antes</Hl> de você esquecer.
              </h2>
              <p className="lead">
                Você responde e diz como foi lembrar. Errou? O cartão volta em minutos. Achou fácil? Só daqui a dias. É
                assim que a memória segura até a prova.
              </p>
              <ul className="ticks">
                <li>Feitos do seu material, com a página de onde saíram</li>
                <li>Repetição espaçada com FSRS: os intervalos do cartão de teste são os do app</li>
                <li>Uns minutos por dia, no ônibus ou no intervalo</li>
              </ul>
            </div>
            <div className="feature-demo">
              <p className="demo-label">Teste aqui: vire o cartão e diga como foi.</p>
              <figure className="source">
                <figcaption>
                  <strong>Biologia</strong> · Transporte pela membrana
                </figcaption>
                <p id="fonte-osmose">
                  <b>Osmose:</b> passagem de água através de uma membrana semipermeável, do meio hipotônico (menos
                  concentrado) para o meio hipertônico (mais concentrado).
                </p>
                <span className="source-page" aria-label="página 12">
                  12
                </span>
              </figure>
              <Flashcard />
            </div>
          </div>
        </section>

        <section id="plano" className="section" aria-labelledby="plano-t">
          <div className="wrap feature feature-flip">
            <div className="feature-copy">
              <p className="eyebrow">Plano</p>
              <h2 id="plano-t" className="h2">
                Me diga a data da prova. <Hl>Eu monto o resto.</Hl>
              </h2>
              <p className="lead">
                Eu divido o conteúdo pelos dias que faltam e marco cada revisão pouco antes de você esquecer. Perdeu um
                dia? Eu reorganizo o plano, sem drama.
              </p>
              <ul className="ticks">
                <li>Uma tela "Hoje" com o que fazer, num botão só</li>
                <li>Várias provas na mesma semana, cada uma com sua data</li>
                <li>Na véspera, revisão leve e cama cedo</li>
              </ul>
            </div>
            <div className="feature-demo">
              <p className="demo-label">Arraste e veja o plano mudar.</p>
              <div className="panel">
                <PlanChart />
              </div>
            </div>
          </div>
        </section>

        <section id="tutor" className="section section-tint" aria-labelledby="tutor-t">
          <div className="wrap feature">
            <div className="feature-copy">
              <p className="eyebrow">Tutor</p>
              <h2 id="tutor-t" className="h2">
                Pergunte. Eu mostro <Hl>de onde tirei.</Hl>
              </h2>
              <p className="lead">
                O tutor responde com base no seu material e aponta a página de cada resposta. Se não estiver lá, eu aviso
                em vez de inventar.
              </p>
              <ul className="ticks">
                <li>Responde direto, puxa o raciocínio com perguntas ou te testa: você escolhe</li>
                <li>Conhecimento geral só quando você pede, e marcado como tal</li>
              </ul>
            </div>
            <div className="feature-demo">
              <p className="demo-label">Este tutor só conhece esta página. Pergunte.</p>
              <Tutor />
            </div>
          </div>
        </section>

        <section id="recursos" className="section" aria-labelledby="recursos-t">
          <div className="wrap">
            <p className="eyebrow">Recursos</p>
            <h2 id="recursos-t" className="h2">
              E tem mais.
            </h2>
            <ul className="tiles">
              {MORE.map((m) => (
                <li key={m.title} className="tile">
                  <h3>{m.title}</h3>
                  <p>{m.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="turma" className="section section-band" aria-labelledby="turma-t">
          <div className="wrap band">
            <img className="band-capi" src={capiCelebrating} alt="" width={200} height={200} />
            <div className="band-copy">
              <h2 id="turma-t" className="h2">
                Melhor ainda com a turma.
              </h2>
              <p className="lead">
                Quem organiza manda os PDFs uma vez e todo mundo estuda pelo mesmo material. Depois é desafiar: duelos 1
                contra 1 e batalha ao vivo na sala.
              </p>
            </div>
          </div>
        </section>

        <section id="baixar" className="section" aria-labelledby="baixar-t">
          <div className="wrap get">
            <div className="get-copy">
              <h2 id="baixar-t" className="h2">
                Comece pela próxima prova.
              </h2>
              <p className="lead">
                Baixe o app, entre com o seu convite e mande o PDF. Eu cuido do resto: resumos, cartões, questões e o
                plano até o dia.
              </p>
              <DownloadButton />
              <p className="note">Por enquanto o Studify é só para Android e funciona por convite.</p>
            </div>
            <div className="panel get-steps">
              <h3>Como instalar no Android</h3>
              <InstallSteps withCode={false} />
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
