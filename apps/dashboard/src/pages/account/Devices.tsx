// Dispositivos: the phones that receive Studify notifications (PLT-05.6), and signing out everywhere (PLT-02.8).
import { useState } from 'react';
import type { AccountOverview } from '@studify/shared';
import { useAccount, useSession } from '../../lib/account.tsx';
import { callApi } from '../../lib/api.ts';
import { formatDate, formatRelative } from '../../lib/format.ts';
import { Button } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Empty, useAction } from '../../ui/feedback.tsx';
import { Icon } from '../../ui/icons.tsx';
import { PageHeader, Row, Section } from '../../ui/layout.tsx';

type Device = AccountOverview['devices'][number];

export function Devices() {
  const { account, setAccount } = useAccount();
  const { signOut } = useSession();
  const { busy, run } = useAction();
  const [removing, setRemoving] = useState<Device | null>(null);
  const [everywhere, setEverywhere] = useState(false);

  const remove = async () => {
    if (!removing) return;
    const next = await run('remove', () => callApi<AccountOverview>('account-device-remove', { device_id: removing.device_id }, { mutating: true }), 'Esse aparelho não recebe mais notificações.');
    if (next) {
      setAccount(next);
      setRemoving(null);
    }
  };

  const signOutEverywhere = async () => {
    await run('global', () => signOut('global', 'Você saiu de todos os aparelhos. Entre de novo quando quiser.'));
  };

  return (
    <div className="page page--narrow">
      <PageHeader title="Dispositivos" description="Onde sua conta está aberta e quais aparelhos recebem os avisos do Studify." />

      <Section title="Recebem notificações" id="aparelhos">
        {account.devices.length === 0 ? (
          <Empty title="Nenhum aparelho recebe notificações">Quando você permitir notificações no app, o aparelho aparece aqui.</Empty>
        ) : (
          <ul className="list">
            {account.devices.map((d) => (
              <li key={d.device_id} className="list-item">
                <div className="inline" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <span className="avatar" aria-hidden="true">
                    <Icon name="phone" />
                  </span>
                  <div>
                    <div className="list-item-title">{d.platform === 'ios' ? 'iPhone' : 'Android'}{d.app_version ? `, app versão ${d.app_version}` : ''}</div>
                    <div className="list-item-meta">
                      Usado {formatRelative(d.last_seen_at)}. Conectado desde {formatDate(d.created_at)}.
                    </div>
                  </div>
                </div>
                <div className="list-item-actions">
                  <Button variant="ghost-danger" size="sm" icon="bell" onClick={() => setRemoving(d)}>
                    Parar notificações
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sessões" id="sessoes">
        <div className="rows">
          <Row label="Sair de todos os dispositivos" hint="Fecha sua conta no app em todos os celulares e neste painel. Revisões que ainda não sincronizaram ficam guardadas no celular." stack>
            <Button variant="secondary" icon="logout" onClick={() => setEverywhere(true)}>
              Sair de todos
            </Button>
          </Row>
        </div>
      </Section>

      <Dialog
        open={removing !== null}
        title="Parar as notificações deste aparelho?"
        onClose={() => setRemoving(null)}
        confirm={{ label: 'Parar notificações', variant: 'danger', busy: busy === 'remove', onConfirm: () => void remove() }}
      >
        <p>O aparelho deixa de receber avisos do Studify. Se você entrar de novo no app por ele, as notificações voltam.</p>
      </Dialog>
      <Dialog
        open={everywhere}
        title="Sair de todos os dispositivos?"
        onClose={() => setEverywhere(false)}
        confirm={{ label: 'Sair de todos', variant: 'danger', busy: busy === 'global', onConfirm: () => void signOutEverywhere() }}
      >
        <p>Você vai precisar entrar de novo com o código do e-mail em cada aparelho, inclusive aqui.</p>
      </Dialog>
    </div>
  );
}
