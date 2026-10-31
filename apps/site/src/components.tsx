import { useState, type ReactNode } from 'react';
import { DOWNLOAD_URL } from './config.ts';

/** The Studify mark: the app icon (Capi over the open book), the same file as the favicon. */
export function BrandMark() {
  return <img className="brand-mark" src="/favicon.svg" width={32} height={32} alt="" />;
}

function Brand({ href }: { href?: string }) {
  const mark = (
    <>
      <BrandMark />
      Studify
    </>
  );
  return href ? (
    <a className="brand" href={href}>
      {mark}
    </a>
  ) : (
    <span className="brand">{mark}</span>
  );
}

const NAV = [
  { href: '#como-funciona', label: 'Como funciona' },
  { href: '#recursos', label: 'Recursos' },
  { href: '#turma', label: 'Turma' },
  { href: '#baixar', label: 'Instalar' },
];

/** The bar on top of every page. The landing page adds its section links and a download key. */
export function SiteHeader({ brandHref, landing = false }: { brandHref?: string; landing?: boolean }) {
  return (
    <header className="topbar">
      <div className="wrap topbar-in">
        <Brand href={brandHref} />
        {landing && (
          <>
            <nav className="nav" aria-label="Seções">
              {NAV.map((n) => (
                <a key={n.href} href={n.href}>
                  {n.label}
                </a>
              ))}
            </nav>
            <a className="key key-primary key-small topbar-cta" href={DOWNLOAD_URL}>
              Baixar o app
            </a>
          </>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <Brand />
        <p>studify.vendua.com.br · Por enquanto só para Android</p>
      </div>
    </footer>
  );
}

/** The link pages: one plain card. Nothing on them moves around, the code has to stay readable. */
export function Page({ brandHref, children }: { brandHref?: string; children: ReactNode }) {
  return (
    <div className="site">
      <SiteHeader brandHref={brandHref} />
      <main className="wrap link-main">
        <div className="panel link-panel">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="link-hero">
      <h1 className="h2">{title}</h1>
      <p className="lead">{subtitle}</p>
    </section>
  );
}

export function DownloadButton({ className = '' }: { className?: string }) {
  return (
    <a className={`key key-primary key-large ${className}`.trim()} href={DOWNLOAD_URL}>
      Baixar o app (Android)
    </a>
  );
}

export function DocIcon() {
  return (
    <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.5 1.5V5H13M6 8h5M6 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls to an element and highlights it for a moment, like opening the cited page in the app. */
function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('lit');
  void el.offsetWidth;
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), 2400);
}

/** A footnote citation (document icon + "p. 12"), never a bubble (ux-guidelines §7). */
export function Cite({ target, children, label }: { target: string; children: ReactNode; label: string }) {
  return (
    <a
      className="cite"
      href={`#${target}`}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        jumpTo(target);
      }}
    >
      <DocIcon />
      {children}
    </a>
  );
}

/** Install help. The link page adds the Play Protect step and the "paste the code" step. */
export function InstallSteps({ withCode }: { withCode: boolean }) {
  return (
    <ol className="install-steps">
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
      <li>
        Volte e toque em <strong>Instalar</strong>. Se o Play Protect avisar, toque em{' '}
        <strong>Mais detalhes → Instalar assim mesmo</strong>.
      </li>
      {withCode ? (
        <li>Abra o Studify, entre com seu e-mail e cole o código acima.</li>
      ) : (
        <li>Abra o Studify, entre com seu e-mail e use o seu código de convite.</li>
      )}
    </ol>
  );
}

/** Install help folded away, for pages where the code and the button come first. */
export function InstallHelp({ withCode }: { withCode: boolean }) {
  return (
    <details className="faq-item">
      <summary>Como instalar no Android</summary>
      <InstallSteps withCode={withCode} />
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
    <section className="code-card">
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
