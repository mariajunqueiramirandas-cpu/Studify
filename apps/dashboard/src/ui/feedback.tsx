// Status and system feedback: toasts (aria-live), banners, empty states and loading. Status always pairs a color
// with an icon and words, never color alone.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { messageOf } from '../lib/api.ts';
import { Button } from './controls.tsx';
import { Icon, type IconName } from './icons.tsx';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-2), { id, message, kind }]);
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'info' ? 'info' : 'check'} size={18} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Runs an action with a busy flag and reports failures as a toast. Returns the action's result or undefined. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const result = await action();
        if (success) toast(success);
        return result;
      } catch (error) {
        toast(messageOf(error), 'error');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return useMemo(() => ({ busy, run }), [busy, run]);
}

type BannerKind = 'info' | 'success' | 'warning' | 'danger' | 'neutral';
const BANNER_ICON: Record<BannerKind, IconName> = { info: 'info', success: 'check', warning: 'alert', danger: 'alert', neutral: 'info' };

export function Banner({ kind = 'info', title, children, action }: { kind?: BannerKind; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner--${kind}`} role={kind === 'danger' || kind === 'warning' ? 'alert' : undefined}>
      <Icon name={BANNER_ICON[kind]} className="banner-icon" />
      <div className="banner-body">
        {title ? <div className="banner-title">{title}</div> : null}
        {children ? <div className="banner-text">{children}</div> : null}
      </div>
      {action ? <div className="banner-action">{action}</div> : null}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-text">{children}</div> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** A read that failed: what happened and a retry. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Banner kind="danger" title="Não consegui carregar esta página." action={<Button size="sm" icon="refresh" onClick={onRetry}>Tentar de novo</Button>}>
      {messageOf(error)}
    </Banner>
  );
}

export function StatusBadge({ tone, icon, children }: { tone: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral'; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`badge ${tone === 'neutral' ? '' : `badge-${tone}`}`}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}
