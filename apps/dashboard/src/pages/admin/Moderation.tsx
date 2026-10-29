// Moderação (SP-09, SP-11, TRU-02): reports about people and content, content flagged as wrong, display names to
// review, and app feedback. Decisions are recorded in the audit log; removals also in the moderation record.
import { useState } from 'react';
import type { AdminModerationQueue } from '@studify/shared';
import { callApi } from '../../lib/api.ts';
import { FLAG_REASONS, ITEM_TYPES, REPORT_REASONS, formatDateTime, formatRelative } from '../../lib/format.ts';
import { useResource } from '../../lib/resource.ts';
import { Link } from '../../lib/router.tsx';
import { Button, Field, TextArea } from '../../ui/controls.tsx';
import { Dialog } from '../../ui/dialog.tsx';
import { Empty, LoadError, Loading, StatusBadge, useAction } from '../../ui/feedback.tsx';
import { PageHeader } from '../../ui/layout.tsx';

type Tab = 'reports' | 'flags' | 'names' | 'feedback';
type Report = AdminModerationQueue['reports'][number];
type Flag = AdminModerationQueue['flags'][number];
type ReportDecision = 'actioned' | 'dismissed' | 'escalated';
type FlagDecision = 'accept' | 'reject' | 'remove';

const REPORT_DECISIONS: Record<ReportDecision, { title: string; label: string; text: string }> = {
  actioned: { title: 'Marcar como resolvida?', label: 'Resolver', text: 'Use depois de agir: recusar o nome, suspender a conta ou remover o conteúdo.' },
  dismissed: { title: 'Descartar a denúncia?', label: 'Descartar', text: 'Use quando não há nada errado. A pessoa que denunciou não é avisada.' },
  escalated: { title: 'Escalar a denúncia?', label: 'Escalar', text: 'Fica marcada como séria para olhar com calma (por exemplo, para pedir ajuda ou guardar evidências).' },
};

const FLAG_DECISIONS: Record<FlagDecision, { title: string; label: string; text: string }> = {
  accept: { title: 'Aceitar a sinalização?', label: 'Aceitar', text: 'Confirma que o conteúdo tem um erro. Ele volta a aparecer e a correção pode ser feita no app.' },
  reject: { title: 'Rejeitar a sinalização?', label: 'Rejeitar', text: 'O conteúdo está certo. Ele volta a aparecer para todo mundo.' },
  remove: { title: 'Remover o conteúdo?', label: 'Remover conteúdo', text: 'O conteúdo some para todo mundo da turma. A remoção fica no registro de moderação.' },
};

export function Moderation() {
  const res = useResource<AdminModerationQueue>('admin-moderation', () => callApi<AdminModerationQueue>('admin-moderation'));
  const [tab, setTab] = useState<Tab>('reports');
  const { busy, run } = useAction();
  const [report, setReport] = useState<{ item: Report; decision: ReportDecision } | null>(null);
  const [flag, setFlag] = useState<{ item: Flag; decision: FlagDecision } | null>(null);
  const [note, setNote] = useState('');
  const q = res.data;

  const decideReport = async () => {
    if (!report) return;
    const next = await run('report', () => callApi<AdminModerationQueue>('admin-moderation-control', { action: 'report', report_id: report.item.id, decision: report.decision, ...(note.trim() ? { note: note.trim() } : {}) }, { mutating: true }), 'Denúncia atualizada.');
    if (next) {
      res.set(next);
      setReport(null);
      setNote('');
    }
  };

  const decideFlag = async () => {
    if (!flag) return;
    const next = await run('flag', () => callApi<AdminModerationQueue>('admin-moderation-control', { action: 'flag', flag_id: flag.item.id, decision: flag.decision }, { mutating: true }), 'Sinalização resolvida.');
    if (next) {
      res.set(next);
      setFlag(null);
    }
  };

  const reviewName = async (userId: string, approve: boolean) => {
    const done = await run(`name:${userId}`, () => callApi('admin-user-control', { action: approve ? 'approve_name' : 'reject_name', user_id: userId }, { mutating: true }), approve ? 'Nome aprovado.' : 'Nome recusado.');
    if (done && q) res.set({ ...q, pending_names: q.pending_names.filter((n) => n.id !== userId) });
  };

  const tabs: Array<{ id: Tab; label: string; count: number }> = q
    ? [
        { id: 'reports', label: 'Denúncias', count: q.reports.length },
        { id: 'flags', label: 'Conteúdo sinalizado', count: q.flags.length },
        { id: 'names', label: 'Nomes', count: q.pending_names.length },
        { id: 'feedback', label: 'Feedback', count: q.feedback.length },
      ]
    : [];

  return (
    <div className="page">
      <PageHeader title="Moderação" description="O que estudantes denunciaram ou sinalizaram e os nomes esperando aprovação. A maioria é de menores de idade: na dúvida, proteja." />
      {!q ? (
        res.error ? <LoadError error={res.error} onRetry={() => void res.reload()} /> : <Loading />
      ) : (
        <div data-refreshing={res.loading}>
          <div className="tabs" role="tablist" aria-label="Filas de moderação">
            {tabs.map((t) => (
              <button key={t.id} id={`tab-${t.id}`} className="tab" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} onClick={() => setTab(t.id)}>
                {t.label}
                <span className="nav-count">{t.count}</span>
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'reports' ? (
              q.reports.length === 0 ? (
                <Empty title="Nenhuma denúncia esperando">Quando alguém denunciar uma pessoa ou um conteúdo pelo app, aparece aqui.</Empty>
              ) : (
                <ul className="list">
                  {q.reports.map((r) => (
                    <li key={r.id} className="list-item">
                      <div>
                        <div className="inline">
                          <span className="list-item-title">{REPORT_REASONS[r.reason] ?? r.reason}</span>
                          {r.status === 'escalated' ? <StatusBadge tone="danger" icon="alert">Escalada</StatusBadge> : null}
                          {r.reason === 'self_harm_concern' ? <StatusBadge tone="danger" icon="alert">Prioridade</StatusBadge> : null}
                        </div>
                        <div className="list-item-meta">
                          {r.reporter_name ?? 'Alguém'} denunciou{' '}
                          {r.reported_id ? <Link to={`/admin/usuarios/${r.reported_id}`}>{r.reported_name ?? 'uma pessoa'}</Link> : 'um conteúdo'}
                          {r.class_group_name ? ` na turma ${r.class_group_name}` : ''}
                          {r.context_type ? `, em ${r.context_type}` : ''}. {formatRelative(r.created_at)}.
                        </div>
                        {r.comment ? <p className="quote">{r.comment}</p> : null}
                      </div>
                      <div className="list-item-actions">
                        <Button size="sm" variant="primary" onClick={() => setReport({ item: r, decision: 'actioned' })}>Resolver</Button>
                        <Button size="sm" onClick={() => setReport({ item: r, decision: 'dismissed' })}>Descartar</Button>
                        {r.status !== 'escalated' ? <Button size="sm" variant="ghost-danger" onClick={() => setReport({ item: r, decision: 'escalated' })}>Escalar</Button> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {tab === 'flags' ? (
              q.flags.length === 0 ? (
                <Empty title="Nenhum conteúdo sinalizado">Estudantes sinalizam cartões, questões e resumos com erro pelo app.</Empty>
              ) : (
                <ul className="list">
                  {q.flags.map((f) => (
                    <li key={f.id} className="list-item">
                      <div>
                        <div className="inline">
                          <span className="list-item-title">
                            {ITEM_TYPES[f.item_type] ?? f.item_type}: {FLAG_REASONS[f.reason] ?? f.reason}
                          </span>
                          {f.status === 'hidden_pending' ? <StatusBadge tone="info">Escondido até decidir</StatusBadge> : null}
                        </div>
                        <div className="list-item-meta">
                          {f.reporter_name ?? 'Alguém'} sinalizou{f.class_group_name ? ` na turma ${f.class_group_name}` : ' num conteúdo pessoal'}. {formatRelative(f.created_at)}.
                        </div>
                        {f.comment ? <p className="quote">{f.comment}</p> : null}
                        {f.ai_verdict ? (
                          <p className="small" style={{ marginTop: 8 }}>
                            <strong>Checagem automática:</strong>{' '}
                            {f.ai_verdict === 'confirmed' ? 'provavelmente tem erro' : f.ai_verdict === 'rejected' ? 'provavelmente está certo' : 'não teve certeza'}
                            {f.ai_confidence ? ` (confiança ${f.ai_confidence === 'high' ? 'alta' : f.ai_confidence === 'medium' ? 'média' : 'baixa'})` : ''}
                            {f.ai_explanation ? `. ${f.ai_explanation}` : '.'}
                          </p>
                        ) : null}
                      </div>
                      <div className="list-item-actions">
                        <Button size="sm" onClick={() => setFlag({ item: f, decision: 'accept' })}>Aceitar</Button>
                        <Button size="sm" onClick={() => setFlag({ item: f, decision: 'reject' })}>Rejeitar</Button>
                        <Button size="sm" variant="ghost-danger" onClick={() => setFlag({ item: f, decision: 'remove' })}>Remover</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {tab === 'names' ? (
              q.pending_names.length === 0 ? (
                <Empty title="Nenhum nome esperando">Nomes novos e trocados passam por aqui antes de a turma ver.</Empty>
              ) : (
                <ul className="list">
                  {q.pending_names.map((n) => (
                    <li key={n.id} className="list-item">
                      <div>
                        <div className="list-item-title" style={{ fontSize: 18 }}>{n.display_name}</div>
                        <div className="list-item-meta">
                          Mudou {formatRelative(n.updated_at)}. <Link to={`/admin/usuarios/${n.id}`}>Ver conta</Link>
                        </div>
                      </div>
                      <div className="list-item-actions">
                        <Button size="sm" variant="primary" icon="check" busy={busy === `name:${n.id}`} onClick={() => void reviewName(n.id, true)}>Aprovar</Button>
                        <Button size="sm" variant="ghost-danger" disabled={busy === `name:${n.id}`} onClick={() => void reviewName(n.id, false)}>Recusar</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {tab === 'feedback' ? (
              q.feedback.length === 0 ? (
                <Empty title="Nenhum feedback ainda">O que estudantes mandarem em Perfil, Enviar feedback, aparece aqui.</Empty>
              ) : (
                <ul className="list">
                  {q.feedback.map((f) => (
                    <li key={f.id} className="list-item">
                      <div>
                        <div className="list-item-meta">
                          <Link to={`/admin/usuarios/${f.user_id}`}>{f.display_name ?? 'Conta'}</Link>, {formatDateTime(f.created_at)}
                          {f.app_version ? `, app ${f.app_version}` : ''}
                          {f.device_model ? `, ${f.device_model}` : ''}
                        </div>
                        <p className="quote">{f.text}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        </div>
      )}

      <Dialog
        open={report !== null}
        title={report ? REPORT_DECISIONS[report.decision].title : ''}
        onClose={() => {
          setReport(null);
          setNote('');
        }}
        confirm={report ? { label: REPORT_DECISIONS[report.decision].label, variant: report.decision === 'escalated' ? 'danger' : 'primary', busy: busy === 'report', onConfirm: () => void decideReport() } : undefined}
      >
        {report ? <p>{REPORT_DECISIONS[report.decision].text}</p> : null}
        <Field label="Nota (opcional)" hint="Fica no registro da administração.">
          {({ id, describedBy }) => <TextArea id={id} value={note} maxLength={500} aria-describedby={describedBy} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </Dialog>

      <Dialog
        open={flag !== null}
        title={flag ? FLAG_DECISIONS[flag.decision].title : ''}
        onClose={() => setFlag(null)}
        confirm={flag ? { label: FLAG_DECISIONS[flag.decision].label, variant: flag.decision === 'remove' ? 'danger' : 'primary', busy: busy === 'flag', onConfirm: () => void decideFlag() } : undefined}
      >
        {flag ? <p>{FLAG_DECISIONS[flag.decision].text}</p> : null}
      </Dialog>
    </div>
  );
}
