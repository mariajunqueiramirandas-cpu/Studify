// The landing page: an apostila about Studify that forgets itself. One second on the page is one hour; what you
// read fades on the app's forgetting curve, key words turn into blanks, and recalling them brings the ink back.
import { useEffect } from 'react';
import capiSleepy from './assets/capi-sleepy.webp';
import { BrandMark, DownloadButton, InstallSteps } from './components.tsx';
import { ErosionFilters, MemoryMap, PageChip, Sheet, Txt } from './forgetting.tsx';
import { startClock } from './page-store.ts';
import { Flashcard, PlanChart, SurpriseQuiz, Tutor } from './widgets.tsx';

function Staple() {
  return (
    <svg className="staple" viewBox="0 0 64 20" aria-hidden="true" focusable="false">
      <path d="M4 15V7a3 3 0 0 1 3-3h50a3 3 0 0 1 3 3v8" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function Landing() {
  useEffect(startClock, []);

  return (
    <div className="desk">
      <ErosionFilters />
      <MemoryMap />
      <main className="stack">
        <Sheet id="p1" page={1} labelledBy="t1" className="sheet-hero">
          <Staple />
          <div className="copy-in">
            <header className="sheet-header">
              <span className="brand">
                <BrandMark />
                Studify
              </span>
              <span className="fields" aria-hidden="true">
                <span>Nome:</span>
                <span className="field-line" />
                <span>Turma:</span>
                <span className="field-line field-short" />
              </span>
            </header>
            <h1 id="t1" className="display">
              <Txt display at={0.4}>
                {'Você vai [esquecer|decorar|amar] esta [página|matéria|frase].'}
              </Txt>
            </h1>
            <p className="body">
              <span id="passagem-memoria" className="passage">
                <Txt at={0.62}>{'Não é culpa sua: é assim que a [memória|internet|preguiça] funciona.'}</Txt>
              </span>{' '}
              <span id="passagem-relogio" className="passage">
                <Txt at={0.76}>{'Aqui, cada segundo vale uma [hora|semana|aula]. Continue lendo e veja o que acontece com o que ficou pra trás.'}</Txt>
              </span>
            </p>
            <div className="app-layer">
              <DownloadButton />
              <p className="hint">Quando uma palavra sumir, toque na lacuna e tente lembrar.</p>
            </div>
          </div>
        </Sheet>

        <Sheet id="p2" page={2} labelledBy="t2">
          <h2 id="t2" className="title">
            <Txt display at={0.45}>
              {'O que você só lê, [apaga|brilha|cansa].'}
            </Txt>{' '}
            <span className="keeps">O que você pratica, fica.</span>
          </h2>
          <p className="body">
            <span id="passagem-material" className="passage">
              <Txt at={0.5}>
                {'Mande o material da aula: slides do professor(a), apostila, anotações, prova antiga. Eu leio tudo e transformo em [resumos|memes|vídeos], cartões e questões. Cada um mostra a [página|nota|hora] de onde saiu.'}
              </Txt>
            </span>
          </p>
          <div className="made-from">
            <div className="made-left">
              <figure className="xerox">
                <figcaption>
                  <strong>Biologia</strong>
                  <span>Transporte pela membrana</span>
                </figcaption>
                <p id="fonte-osmose" className="passage">
                  <b>Osmose:</b> passagem de água através de uma membrana semipermeável, do meio hipotônico (menos
                  concentrado) para o meio hipertônico (mais concentrado).
                </p>
                <span className="xerox-page" aria-label="página 12">
                  12
                </span>
              </figure>
              <div className="summary">
                <h3>Resumo</h3>
                <p className="reading">
                  <Txt at={0.75}>{'**Osmose** é a passagem de **água** por uma membrana, do meio **menos concentrado** pro **mais concentrado**.'}</Txt>{' '}
                  <PageChip page={12} passage="fonte-osmose" />
                </p>
              </div>
            </div>
            <div className="made-right">
              <h3>Cartão</h3>
              <Flashcard />
            </div>
          </div>
        </Sheet>

        <Sheet id="p3" page={3} labelledBy="t3">
          <h2 id="t3" className="title">
            <Txt display at={0.45}>
              {'Me diga a data da prova. Eu monto o [resto|lanche|grupo].'}
            </Txt>
          </h2>
          <p className="body">
            <span id="passagem-plano" className="passage">
              <Txt at={0.55}>
                {'Eu divido o conteúdo pelos dias que faltam e marco cada revisão pouco antes de você [esquecer|dormir|desistir]. Perdeu um dia? Eu reorganizo o plano, sem drama.'}
              </Txt>
            </span>
          </p>
          <PlanChart />
        </Sheet>

        <Sheet id="p4" page={4} labelledBy="t4">
          <h2 id="t4" className="title">
            <Txt display at={0.45}>
              {'Pergunte. Eu mostro a [página|resposta|cola].'}
            </Txt>
          </h2>
          <p className="body">
            <span id="passagem-tutor" className="passage">
              <Txt at={0.55}>
                {'O tutor responde com base no seu material e aponta de onde tirou cada resposta. Se a resposta não estiver lá, eu [aviso|invento|enrolo] em vez de inventar.'}
              </Txt>
            </span>
          </p>
          <Tutor />
        </Sheet>

        <Sheet id="p5" page={5} labelledBy="t5">
          <h2 id="t5" className="title">
            <Txt display at={0.45}>
              {'Prova [surpresa|final|oral].'}
            </Txt>
          </h2>
          <p className="body">
            <Txt at={0.9}>{'Você leu tudo isso há algumas horas, no relógio desta página. Vamos ver o que ficou.'}</Txt>
          </p>
          <p className="body">
            <span id="passagem-erros" className="passage">
              <Txt at={0.6}>{'No app, cada erro vai pro [Caderno de Erros|lixo|esquecimento] e vira um cartão pra você revisar.'}</Txt>
            </span>
          </p>
          <SurpriseQuiz />
        </Sheet>

        <Sheet id="p6" page={6} labelledBy="t6" className="sheet-back">
          <h2 id="t6" className="title">
            Agora com o seu material.
          </h2>
          <p className="body">
            Baixe o app, entre com o seu convite e mande o PDF da próxima prova. Eu cuido do resto: resumos, cartões,
            questões e o plano até o dia.
          </p>
          <p className="body">
            <span id="passagem-turma" className="passage">
              Melhor ainda com a turma: quem organiza manda os PDFs uma vez e todo mundo estuda pelo mesmo material, com
              duelos e batalha ao vivo.
            </span>
          </p>
          <DownloadButton />
          <InstallSteps withCode={false} />
          <p className="note">
            <span id="passagem-android" className="passage">
              Por enquanto o Studify é só para Android e funciona por convite.
            </span>
          </p>
          <div className="goodnight">
            <img src={capiSleepy} alt="" width={128} height={128} />
            <p>Dormir bem também é estudar: é no sono que a memória fixa o que você revisou.</p>
          </div>
        </Sheet>
        <footer className="desk-footer">studify.vendua.com.br</footer>
      </main>
    </div>
  );
}
