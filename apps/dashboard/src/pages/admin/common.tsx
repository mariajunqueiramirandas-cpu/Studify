// Pieces shared by the Administração pages.
import type { AdminUserRow } from '@studify/shared';
import { StatusBadge } from '../../ui/feedback.tsx';

type Badged = Pick<AdminUserRow, 'app_role' | 'display_name_status' | 'banned_until' | 'is_minor' | 'deleted_at'> & { deletion_pending?: boolean };

/** Who this person is to the owner, in words: admin, minor, name to review, suspended, deleting. */
export function UserBadges({ user }: { user: Badged }) {
  const suspended = user.banned_until !== null && Date.parse(user.banned_until) > Date.now();
  return (
    <span className="inline" style={{ gap: 6 }}>
      {user.app_role === 'app_admin' ? <StatusBadge tone="primary">Admin</StatusBadge> : null}
      {suspended ? <StatusBadge tone="danger" icon="ban">Suspensa</StatusBadge> : null}
      {user.deleted_at || user.deletion_pending ? <StatusBadge tone="danger" icon="trash">Excluindo</StatusBadge> : null}
      {user.display_name_status === 'pending' ? <StatusBadge tone="info" icon="clock">Nome em análise</StatusBadge> : null}
      {user.display_name_status === 'rejected' ? <StatusBadge tone="warning" icon="alert">Nome recusado</StatusBadge> : null}
      {user.is_minor ? <StatusBadge tone="neutral">Menor de idade</StatusBadge> : null}
    </span>
  );
}

export function RefreshedAt({ at }: { at: string }) {
  return <span className="muted small">Atualizado às {new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>;
}
