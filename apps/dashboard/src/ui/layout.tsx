// Page structure: the header, sections, settings rows and the figures row.
import type { ReactNode } from 'react';
import { Link } from '../lib/router.tsx';
import { Icon } from './icons.tsx';

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {back ? (
          <Link to={back.to} className="back-link">
            <Icon name="left" size={18} />
            {back.label}
          </Link>
        ) : null}
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, description, actions, children, id }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={title && id ? `${id}-title` : undefined}>
      {title || actions ? (
        <div className="section-head">
          <div>
            {title ? (
              <h2 className="section-title" id={id ? `${id}-title` : undefined}>
                {title}
              </h2>
            ) : null}
            {description ? <p className="section-desc">{description}</p> : null}
          </div>
          {actions ? <div className="inline">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Row({ label, hint, children, wide, stack, hintId }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; wide?: boolean; stack?: boolean; hintId?: string }) {
  return (
    <div className={`row${wide ? ' row--wide' : ''}${stack ? ' row--stack' : ''}`}>
      <div>
        <div className="row-label">{label}</div>
        {hint ? (
          <div className="row-hint" id={hintId}>
            {hint}
          </div>
        ) : null}
      </div>
      {children ? <div className="row-control">{children}</div> : null}
    </div>
  );
}

export function Figures({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="figures" role="list" aria-label={label}>
      {children}
    </div>
  );
}

export function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="figure" role="listitem">
      <div className="figure-label">{label}</div>
      <div className="figure-value">{value}</div>
      {note ? <div className="figure-note">{note}</div> : null}
    </div>
  );
}
