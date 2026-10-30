import { useState, type ReactNode } from 'react';
import { DOWNLOAD_URL } from './config.ts';

/** The link pages: one plain sheet on the desk. Nothing on them fades, the code has to stay readable. */
export function Page({ brandHref, children }: { brandHref?: string; children: ReactNode }) {
  const mark = (
    <>
      <span className="brand-mark" aria-hidden="true">S</span>Studify
    </>
  );
  return (
    <div className="desk desk-single">
      <main className="sheet link-sheet">
        {brandHref ? (
          <a className="brand" href={brandHref}>
            {mark}
          </a>
        ) : (
          <span className="brand">{mark}</span>
        )}
        {children}
      </main>
      <footer className="desk-footer">studify.vendua.com.br</footer>
    </div>
  );
}

export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="link-hero">
      <h1 className="title">{title}</h1>
      <p className="body">{subtitle}</p>
    </section>
  );
}

export function DownloadButton() {
  return (
    <a className="key key-primary key-large" href={DOWNLOAD_URL}>
      Baixar o app (Android)
    </a>
  );
}

/** Install help. The link page adds the Play Protect step and the "paste the code" step. */
export function InstallSteps({ withCode }: { withCode: boolean }) {
  return (
    <details className="install">
      <summary>Como instalar no Android</summary>
      <ol>
        <li>
          Toque em <strong>Baixar o app (Android)</strong> e abra o arquivo quando o download terminar.
        </li>
        {withCode ? (
          <li>
            Se aparecer "Por segurança, seu celular não permite instalar apps desta fonte", toque em{' '}
            <strong>Configurações</strong> e ative <strong>Permitir desta fonte</strong>.
          </li>
        ) : (
          <li>
            Se o celular pedir, ative <strong>Permitir desta fonte</strong> nas configurações.
          </li>
        )}
        {withCode ? (
          <li>
            Volte e toque em <strong>Instalar</strong>. Se o Play Protect avisar, toque em{' '}
            <strong>Mais detalhes → Instalar assim mesmo</strong>.
          </li>
        ) : (
          <li>
            Volte e toque em <strong>Instalar</strong>.
          </li>
        )}
        {withCode && <li>Abra o Studify, entre com seu e-mail e cole o código acima.</li>}
      </ol>
    </details>
  );
}

export function CodeCard({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => {},
    );
  };
  return (
    <section className="card">
      <span className="label">{label}</span>
      <span className="code" aria-live="polite">
        {code}
      </span>
      <button className="key" type="button" onClick={copy}>
        {copied ? 'Copiado ✓' : 'Copiar'}
      </button>
      <p>Depois de instalar, cole este código no app.</p>
    </section>
  );
}
