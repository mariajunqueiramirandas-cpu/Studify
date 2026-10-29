// Form controls. Each control keeps its native element (button, input, select), so keyboard and screen readers
// work without extra wiring.
import { useId, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'ghost-danger';
  size?: 'md' | 'sm';
  icon?: IconName;
  busy?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', icon, busy, disabled, children, className, type = 'button', ...rest }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

export function Switch({ label, checked, onChange, disabled, describedBy }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; describedBy?: string }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      aria-label={label}
      aria-describedby={describedBy}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface FieldProps {
  label: string;
  /** Keeps the label for screen readers only, when the row already shows it. */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, hint and error wired to the control by id. */
export function Field({ label, hideLabel, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className={hideLabel ? 'visually-hidden' : 'field-label'} htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="field-error" id={errorId} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={`input ${className ?? ''}`} {...props} />;
}

export function Select({ children, ...props }: ComponentProps<'select'>) {
  return (
    <select className="select" {...props}>
      {children}
    </select>
  );
}

export function TextArea(props: ComponentProps<'textarea'>) {
  return <textarea className="textarea" {...props} />;
}

/** A dollar amount typed by the owner. */
export function MoneyInput(props: ComponentProps<'input'>) {
  return (
    <span className="input-with-prefix">
      <span aria-hidden="true">US$</span>
      <input className="input input-money num" inputMode="decimal" autoComplete="off" {...props} />
    </span>
  );
}
