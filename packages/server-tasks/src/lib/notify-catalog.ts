// Push catalog (api.md §9, PLT-05.7). Only server-delivered types are listed; local types are
// scheduled on the device and never reach notify.dispatch. Copy is PT-BR and short.

export type NotifyChannel = 'reviews' | 'plan' | 'class' | 'processing';

export interface NotifyEntry {
  channel: NotifyChannel;
  /** Counts toward the 3-per-day cap for unrequested notifications (PLT-05.4). */
  countsTowardCap: boolean;
  delivery: 'push' | 'local';
  title: string;
  body: string;
  /** Deep link template; `{key}` placeholders are filled from the dispatch data. */
  deepLink: string;
}

export const NOTIFY_CATALOG: Readonly<Record<string, NotifyEntry>> = {
  material_ready: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Material pronto', body: 'Seu material já está pronto para estudar.', deepLink: 'studify://subjects/{subject_id}' },
  material_failed: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Não consegui processar o material', body: 'Tente enviar o arquivo de novo.', deepLink: 'studify://subjects/{subject_id}/document/{document_id}' },
  reviews_due: { channel: 'reviews', countsTowardCap: true, delivery: 'local', title: 'Revisões do dia', body: 'Tem cartões esperando por você.', deepLink: 'studify://practice/review' },
  daily_plan: { channel: 'plan', countsTowardCap: false, delivery: 'local', title: 'Plano de hoje', body: 'Seu plano de hoje está pronto.', deepLink: 'studify://today' },
  exam_eve: { channel: 'plan', countsTowardCap: false, delivery: 'local', title: 'Véspera da prova', body: 'Hora da revisão da véspera.', deepLink: 'studify://goal/{goal_id}/eve/{exam_id}' },
  grade_log_prompt: { channel: 'plan', countsTowardCap: true, delivery: 'local', title: 'Registrar nota', body: 'Quanto você tirou na prova?', deepLink: 'studify://goal/{goal_id}/exam/{exam_id}?log=1' },
  essay_graded: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Redação corrigida', body: 'Sua redação foi corrigida.', deepLink: 'studify://enem/essay/{essay_id}' },
  podcast_ready: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Podcast pronto', body: 'Seu episódio está pronto para ouvir.', deepLink: 'studify://podcast/{episode_id}' },
  export_ready: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Seus dados estão prontos', body: 'O arquivo com seus dados já pode ser baixado.', deepLink: 'studify://profile/privacy' },
  duel_challenge: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Novo desafio', body: 'Um colega te desafiou para um duelo.', deepLink: 'studify://class/{class_group_id}/duel/{duel_id}' },
  duel_finished: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Duelo terminado', body: 'Veja o resultado do seu duelo.', deepLink: 'studify://class/{class_group_id}/duel/{duel_id}' },
  battle_starting: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Batalha começando', body: 'Entre na batalha da sua turma.', deepLink: 'studify://class/{class_group_id}/battle/{battle_id}' },
  subject_shared: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Matéria compartilhada', body: 'Um colega compartilhou uma matéria com a turma.', deepLink: 'studify://subjects/{subject_id}' },
  join_request: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Pedido para entrar', body: 'Alguém pediu para entrar na sua turma.', deepLink: 'studify://class/{class_group_id}?tab=members' },
  content_fixed: { channel: 'processing', countsTowardCap: false, delivery: 'push', title: 'Itens corrigidos', body: 'Alguns itens que você estudou foram corrigidos.', deepLink: 'studify://today' },
  streak_at_risk: { channel: 'plan', countsTowardCap: true, delivery: 'local', title: 'Sua sequência está em risco', body: 'Estude um pouco hoje para manter a sequência.', deepLink: 'studify://today' },
  // Phase 4 (ENM-09.5, ENM-10)
  atualidades_published: { channel: 'plan', countsTowardCap: true, delivery: 'push', title: 'Atualidades da semana', body: 'O resumo de Atualidades pro ENEM saiu.', deepLink: 'studify://enem/atualidades/{digest_id}' },
  // Phase 5
  divide_merged: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Resumo da turma pronto', body: 'A divisão terminou: o Resumo da turma já está no app.', deepLink: 'studify://class/{class_group_id}/divide/{divide_plan_id}' },
  retro_ready: { channel: 'plan', countsTowardCap: true, delivery: 'push', title: 'Sua Retrospectiva chegou ✨', body: 'Veja um resumo dos seus estudos.', deepLink: 'studify://retro' },
  reta_final_start: { channel: 'plan', countsTowardCap: false, delivery: 'push', title: 'Começou a Reta Final! 🏁', body: 'Seu plano agora foca no que mais cai e nos simulados no horário real.', deepLink: 'studify://enem/reta-final' },
  enem_eve: { channel: 'plan', countsTowardCap: false, delivery: 'push', title: 'Amanhã é dia de ENEM', body: 'Revisão leve hoje, separe documento e caneta preta transparente, e durma cedo.', deepLink: 'studify://enem/reta-final' },
  enem_between_days: { channel: 'plan', countsTowardCap: false, delivery: 'push', title: 'Descansa primeiro', body: 'Revisão leve de Natureza e Matemática, sem ficar conferindo gabarito extraoficial.', deepLink: 'studify://enem/reta-final' },
  enem_exam_day: { channel: 'plan', countsTowardCap: false, delivery: 'push', title: 'Boa prova! 🍀', body: 'Boa prova! Documento e caneta preta transparente na mochila? 🍀', deepLink: 'studify://enem/reta-final' },
  content_flag_review: { channel: 'class', countsTowardCap: true, delivery: 'push', title: 'Denúncia para revisar', body: 'Há um item da turma aguardando revisão.', deepLink: 'studify://class/{class_group_id}?tab=review' },
};

export function notifyEntry(type: string): NotifyEntry | null {
  return NOTIFY_CATALOG[type] ?? null;
}

/** Fills `{key}` placeholders from data; unknown keys become empty strings. */
export function fillTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = data[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
