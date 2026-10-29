// Formatting and the PT-BR vocabulary of the dashboard. Money appears only on Administração pages (US$, from
// micro-USD); students see their AI use as a percentage of the daily limit (PLT-04.2).

const LOCALE = 'pt-BR';
const ZONE = 'America/Sao_Paulo';

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const usd2 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd4 = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatInt(value: number | null | undefined): string {
  return integer.format(value ?? 0);
}

/** 1.284 → "1,3 mil"; small numbers stay whole. */
export function formatCompact(value: number): string {
  return Math.abs(value) < 10_000 ? integer.format(value) : compact.format(value);
}

/** Micro-USD to "US$ 1,23"; amounts under a cent keep up to 4 decimals so they do not read as zero. */
export function formatUsd(microUsd: number | null | undefined): string {
  const usd = (microUsd ?? 0) / 1_000_000;
  return usd !== 0 && Math.abs(usd) < 0.01 ? usd4.format(usd) : usd2.format(usd);
}

/** Axis labels for money: as many decimals as the tick step needs (0,005 needs three), at least two. */
export function formatUsdTick(microUsd: number, stepMicroUsd: number): string {
  const step = stepMicroUsd / 1_000_000;
  let decimals = 2;
  while (decimals < 6 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-6) decimals++;
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(microUsd / 1_000_000);
}

/** "12%"; ratios (0–1) with `ratio`. */
export function formatPct(value: number | null | undefined, options: { ratio?: boolean; digits?: number } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = options.ratio ? value * 100 : value;
  return `${pct.toLocaleString(LOCALE, { maximumFractionDigits: options.digits ?? 0 })}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${integer.format(ms)} ms` : `${(ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`;
}

/** Dollars typed by the owner ("1,50" or "1.50") to micro-USD; null when it is not a number. */
export function parseUsd(input: string): number | null {
  const clean = input.trim().replace(/^US\$\s*/i, '').replace(/\s/g, '');
  if (!/^\d+([.,]\d{1,4})?$/.test(clean)) return null;
  return Math.round(Number(clean.replace(',', '.')) * 1_000_000);
}

/** Micro-USD to the plain value shown in an input ("1.5" → "1,50"). */
export function usdInput(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return '';
  return (microUsd / 1_000_000).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false });
}

const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: ZONE });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ZONE });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' });

export function formatDate(iso: string | null | undefined): string {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTimeFmt.format(new Date(iso)) : '—';
}

/** A calendar day (YYYY-MM-DD) as "27 de out." — no timezone shift. */
export function formatDay(day: string, withWeekday = false): string {
  const date = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  return (withWeekday ? weekdayFmt : dayFmt).format(date);
}

export function monthName(day: string): string {
  return monthFmt.format(new Date(`${day.slice(0, 10)}T12:00:00Z`));
}

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Infinity],
];

/** "há 3 dias", "agora", "em 2 semanas"-style relative time. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  let delta = (Date.parse(iso) - now) / 1000;
  if (Math.abs(delta) < 45) return 'agora';
  for (const [unit, size] of STEPS) {
    if (Math.abs(delta) < size) return relative.format(Math.round(delta), unit);
    delta /= size;
  }
  return relative.format(Math.round(delta), 'year');
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

/** Invite codes are shown in two groups of four (spec 00 §8.2). */
export function groupCode(code: string): string {
  return code.replace(/^(.{4})(.{4})$/, '$1-$2');
}

// ---------------------------------------------------------------- vocabulary

export const SCHOOL_YEARS: Record<string, string> = {
  ef9: '9º ano',
  em1: '1ª série',
  em2: '2ª série',
  em3: '3ª série',
  cursinho: 'Cursinho',
  outro: 'Outro',
};

/** PRD feature ids to the names students know from the app. Unknown ids show as they are. */
const FEATURES: Record<string, string> = {
  'PLT-02': 'Revisão de nomes',
  'ING-01': 'Leitura de materiais',
  'ING-02': 'Leitura de materiais',
  'ING-03': 'Mapa do conteúdo',
  'ING-04': 'Edição do sumário',
  'ING-06': 'Revisor de material',
  'ING-07': 'Importar cronograma',
  'LRN-01': 'Resumos',
  'LRN-02': 'Glossário',
  'LRN-03': 'Explica de outro jeito',
  'LRN-04': 'Mapa de conceitos',
  'LRN-05': 'Visuais',
  'MEM-01': 'Cartões',
  'MEM-03': 'Cartões com imagem',
  'MEM-06': 'Mnemônicos',
  'FED-01': 'Feed de estudos',
  'PRA-01': 'Quizzes',
  'PRA-02': 'Explicação de erros',
  'PRA-03': 'Simulados',
  'PRA-04': 'Caderno de Erros',
  'PRA-06': 'Ache o Erro',
  'PRA-07': 'Correção de dissertativas',
  'PRA-08': 'Listas de exercícios',
  'PRA-09': 'Prova Provável',
  'TUT-01': 'Tutor',
  'TUT-02': 'Tutor',
  'TUT-03': 'Tutor',
  'TUT-04': 'Tutor',
  'TUT-05': 'Tutor',
  'TUT-06': 'Tutor por voz',
  'GOL-03': 'Conteúdo da prova',
  'GOL-04': 'Plano de estudos',
  'GOL-07': 'Modo Véspera',
  'GOL-12': 'Modo Desespero',
  'SOC-02': 'Duelos',
  'SOC-03': 'Batalha ao vivo',
  'SOC-06': 'Dividir e conquistar',
  'SOC-07': 'Perguntas da turma',
  'CAM-01': 'Câmera mágica',
  'CAM-02': 'Resolver pela foto',
  'CAM-03': 'Correção pela foto',
  'INT-01': 'Podcast interativo',
  'INT-02': 'Ensine o Lucas',
  'INT-03': 'Treino de argumentação',
  'ENM-03': 'Questões estilo ENEM',
  'ENM-04': 'Simulado ENEM',
  'ENM-05': 'Correção de redação',
  'ENM-08': 'Prova Provável ENEM',
  'ENM-09': 'Atualidades',
  'TRU-02': 'Checagem de sinalizações',
  'TRL-01': 'Trilha',
  'MOT-04': 'Retrospectiva',
};

export function featureName(code: string): string {
  return FEATURES[code] ?? code;
}

export const REPORT_REASONS: Record<string, string> = {
  harassment: 'Assédio',
  inappropriate_name: 'Nome inadequado',
  inappropriate_content: 'Conteúdo inadequado',
  spam: 'Spam',
  copyright: 'Direitos autorais',
  self_harm_concern: 'Preocupação com autolesão',
  other: 'Outro motivo',
};

export const FLAG_REASONS: Record<string, string> = {
  wrong_answer: 'Resposta errada',
  wrong_fact: 'Informação errada',
  wrong_page: 'Página errada',
  unclear: 'Confuso',
  inappropriate: 'Inadequado',
  copyright: 'Direitos autorais',
  other: 'Outro motivo',
};

export const ITEM_TYPES: Record<string, string> = {
  knowledge_node: 'Tópico',
  note: 'Resumo',
  glossary_term: 'Termo do glossário',
  card: 'Cartão',
  question: 'Questão',
  explanation: 'Explicação',
  feed_item: 'Item do feed',
  podcast_episode: 'Episódio de podcast',
  tutor_message: 'Resposta do tutor',
  visual: 'Visual',
  document: 'Material',
};

export const ROLES: Record<string, string> = { owner: 'Dona(o)', moderator: 'Moderação', member: 'Membro' };

export const EXPORT_STATUS: Record<string, string> = {
  queued: 'Na fila',
  running: 'Preparando',
  ready: 'Pronto',
  failed: 'Não deu certo',
  expired: 'Expirado',
};

export const JOB_STATUS: Record<string, string> = {
  queued: 'Na fila',
  running: 'Rodando',
  waiting_batch: 'Em lote',
  waiting_budget: 'Esperando limite',
  succeeded: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

export const AUDIT_ACTIONS: Record<string, string> = {
  'user.set_role': 'Mudou o papel',
  'user.approve_name': 'Aprovou o nome',
  'user.reject_name': 'Recusou o nome',
  'user.suspend': 'Suspendeu a conta',
  'user.unsuspend': 'Reativou a conta',
  'user.set_daily_limit': 'Mudou o limite diário de IA',
  'class_group.set_budget': 'Mudou o limite da turma',
  'report.actioned': 'Resolveu uma denúncia',
  'report.dismissed': 'Descartou uma denúncia',
  'report.escalated': 'Escalou uma denúncia',
  'flag.accept': 'Aceitou uma sinalização',
  'flag.reject': 'Rejeitou uma sinalização',
  'flag.remove': 'Removeu um conteúdo',
  'settings.set_limits': 'Mudou os limites de IA',
  'flag.upsert': 'Mudou um recurso',
  'version.block': 'Mudou a versão mínima',
  'invite.create': 'Criou um convite',
  'invite.revoke': 'Revogou um convite',
};

/** Brazil's zones with the names people use; another stored zone is listed as it is. */
export const TIME_ZONES: Array<[string, string]> = [
  ['America/Sao_Paulo', 'Brasília (SP, RJ, MG, Sul, GO, DF)'],
  ['America/Bahia', 'Bahia'],
  ['America/Fortaleza', 'Ceará, RN, PB, PI, MA'],
  ['America/Recife', 'Pernambuco'],
  ['America/Maceio', 'Alagoas e Sergipe'],
  ['America/Belem', 'Pará e Amapá'],
  ['America/Araguaina', 'Tocantins'],
  ['America/Cuiaba', 'Mato Grosso'],
  ['America/Campo_Grande', 'Mato Grosso do Sul'],
  ['America/Manaus', 'Amazonas'],
  ['America/Porto_Velho', 'Rondônia'],
  ['America/Boa_Vista', 'Roraima'],
  ['America/Rio_Branco', 'Acre'],
  ['America/Noronha', 'Fernando de Noronha'],
];

/** Length of a quiet window that may cross midnight, in minutes (22:00–07:00 → 540). */
export function quietMinutes(start: string, end: string): number {
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return (toMin(end) - toMin(start) + 1440) % 1440;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
