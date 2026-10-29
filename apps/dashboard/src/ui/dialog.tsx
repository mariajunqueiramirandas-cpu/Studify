// Modal dialogs on the native <dialog> element: focus moves in and back, Escape closes, the page behind is inert.
import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { Button } from './controls.tsx';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The confirm button; omitted for an informational dialog. */
  confirm?: { label: string; variant?: 'primary' | 'danger'; disabled?: boolean; busy?: boolean; onConfirm: () => void };
  cancelLabel?: string;
}

export function Dialog({ open, title, onClose, children, confirm, cancelLabel = 'Cancelar' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (confirm && !confirm.disabled && !confirm.busy) confirm.onConfirm();
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (confirm?.busy) e.preventDefault();
      }}
    >
      {open ? (
        <form className="dialog-form" onSubmit={submit}>
          <div className="dialog-body">
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            {children}
          </div>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={onClose} disabled={confirm?.busy}>
              {confirm ? cancelLabel : 'Fechar'}
            </Button>
            {confirm ? (
              <Button type="submit" variant={confirm.variant ?? 'primary'} disabled={confirm.disabled} busy={confirm.busy}>
                {confirm.label}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
