// Turmas: the Turmas you are in, your choices in each (weekly league, duels, anonymous class statistics) and
// leaving one. Joining a Turma happens in the app with its code.
import { useState } from 'react';
import type { AccountOverview } from '@studify/shared';
import { useAccount } from '../../lib/account.tsx';
import { callApi } from '../../lib/api.ts';
import { ROLES, formatDate, formatInt } from '../../lib/format.ts';
import { Button, Switch } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Empty, StatusBadge, useAction } from '../../ui/feedback.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type Group = AccountOverview['class_groups'][number];
type Choice = 'league_opt_in' | 'accepts_duels' | 'contribute_insights';
const CHOICES: Array<{ key: Choice; label: string; hint: string }> = [
  { key: 'league_opt_in', label: 'Participar da liga semanal', hint: 'Seu XP da semana aparece no ranking da turma.' },
  { key: 'accepts_duels', label: 'Aceitar duelos', hint: 'Colegas podem te chamar para duelos de quiz.' },
  { key: 'contribute_insights', label: 'Contribuir com estatísticas da turma', hint: 'Seus acertos entram nas estatísticas sem nome (mínimo de 5 pessoas).' },
];

export function ClassGroups() {
  const { account, setAccount } = useAccount();
  const { busy, run } = useAction();
  const [leaving, setLeaving] = useState<Group | null>(null);

  const update = async (group: Group, key: Choice, value: boolean) => {
    const previous = account;
    setAccount({ ...account, class_groups: account.class_groups.map((g) => (g.id === group.id ? { ...g, [key]: value } : g)) });
    const next = await run(`${group.id}:${key}`, () => callApi<AccountOverview>('account-membership', { action: 'update', class_group_id: group.id, [key]: value }, { mutating: true }));
    setAccount(next ?? previous);
  };

  const leave = async () => {
    if (!leaving) return;
    const next = await run('leave', () => callApi<AccountOverview>('account-membership', { action: 'leave', class_group_id: leaving.id }, { mutating: true }), `Você saiu de ${leaving.name}.`);
    if (next) {
      setAccount(next);
      setLeaving(null);
    }
  };

  return (
    <div className="page page--narrow">
      <PageHeader title="Turmas" description="As turmas em que você está e o que você compartilha com cada uma. Para entrar numa turma, use o código dela no app." />

      {account.class_groups.length === 0 ? (
        <Empty title="Você ainda não está em nenhuma turma">Peça o código ou o link da turma pra quem organiza e entre pelo app, na aba Turma.</Empty>
      ) : (
        account.class_groups.map((group) => (
          <Section
            key={group.id}
            id={`turma-${group.id}`}
            title={group.name}
            description={
              group.status === 'pending'
                ? 'Esperando a aprovação de quem organiza a turma.'
                : `${formatInt(group.members)} ${group.members === 1 ? 'pessoa' : 'pessoas'}${group.joined_at ? `, você entrou em ${formatDate(group.joined_at)}` : ''}`
            }
            actions={
              <>
                <StatusBadge tone={group.role === 'member' ? 'neutral' : 'primary'}>{ROLES[group.role]}</StatusBadge>
                {group.status === 'pending' ? <StatusBadge tone="info" icon="clock">Pendente</StatusBadge> : null}
              </>
            }
          >
            {group.status === 'active' ? (
              <div className="rows">
                {CHOICES.map((c) => (
                  <Row key={c.key} label={c.label} hint={c.hint} hintId={`${group.id}-${c.key}`}>
                    <Switch label={c.label} describedBy={`${group.id}-${c.key}`} checked={group[c.key]} disabled={busy === `${group.id}:${c.key}`} onChange={(v) => void update(group, c.key, v)} />
                  </Row>
                ))}
                <Row
                  label="Sair da turma"
                  hint={group.role === 'owner' ? 'Você é dono(a) desta turma. Passe a turma para outra pessoa no app antes de sair.' : 'O que você compartilhou continua com a turma.'}
                >
                  <Button variant="ghost-danger" icon="logout" disabled={group.role === 'owner'} onClick={() => setLeaving(group)}>
                    Sair
                  </Button>
                </Row>
              </div>
            ) : null}
          </Section>
        ))
      )}

      <Dialog
        open={leaving !== null}
        title={`Sair de ${leaving?.name ?? ''}?`}
        onClose={() => setLeaving(null)}
        confirm={{ label: 'Sair da turma', variant: 'danger', busy: busy === 'leave', onConfirm: () => void leave() }}
      >
        <p>Você deixa de ver os materiais, duelos e batalhas da turma. O que você compartilhou fica com ela. Para voltar, vai precisar de um novo convite.</p>
      </Dialog>
    </div>
  );
}
