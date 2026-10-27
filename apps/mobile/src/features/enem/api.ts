// ENEM mode client (spec 09; api §4.9): goal, edition dates, estimates, Meta SISU, bank, simulados, redação,
// Atualidades, repertório and Treino de Argumentação. Global ENEM content is read online (never mirrored).
import {
  currentEstimates,
  sisuTargets,
  type ArgumentFinishRes,
  type ArgumentStartReq,
  type ArgumentStartRes,
  type ArgumentThemesRes,
  type EnemArea,
  type EnemAreaResults,
  type EnemSimuladoCreateReq,
  type EnemSimuladoCreateRes,
  type EssayThemeGenerateReq,
  type EssayThemeGenerateRes,
  type SisuManual,
  type SisuScores,
  type SisuTargetsJson,
} from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction, streamFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';
import { useGoals, type Goal } from '../goals/api';
import { toEventHandler, type StreamHandlers } from '../learn/api';

export const AREAS: readonly EnemArea[] = ['LC', 'CH', 'CN', 'MT'];

export interface EnemGoalSettings {
  enem_edition?: number;
  enem_date_override?: string;
  language?: 'en' | 'es';
  enem_min_share?: number;
  reta_final_weeks?: number;
}

/** The active ENEM goal (one at a time). */
export function useEnemGoal() {
  const goals = useGoals();
  const goal = (goals.data ?? []).find((g) => g.mode === 'enem') ?? null;
  return { ...goals, goal: goal as (Goal & { settings: EnemGoalSettings }) | null };
}

export interface Edition {
  year: number;
  day1_date: string | null;
  day2_date: string | null;
  dates_status: 'official' | 'provisional';
  gates_open: string | null;
  gates_close: string | null;
  start_time: string | null;
  timezone: string;
  day1_duration_min: number | null;
  day2_duration_min: number | null;
  checklist: Array<{ text: string } | string>;
  edital_url: string | null;
  verified_at: string | null;
}

export function useEditions() {
  return useQuery({ queryKey: ['enem', 'editions'], staleTime: 60 * 60 * 1000, queryFn: () => rows<Edition>(supabase.from('enem_editions').select('*').order('year')) });
}

export interface EnemDates {
  edition: Edition | null;
  day1: string | null;
  day2: string | null;
  provisional: boolean;
}

/** Day 1/Day 2 for a goal: the student's override, the edition row, else the goal's end date as Day 2 (ENM-01.2). */
export function enemDatesFor(goal: { end_date: string; settings: EnemGoalSettings } | null, editions: readonly Edition[], today: string): EnemDates {
  if (!goal) return { edition: null, day1: null, day2: null, provisional: true };
  const edition = editions.find((e) => e.year === goal.settings?.enem_edition) ?? editions.filter((e) => e.day1_date && e.day1_date >= today).sort((a, b) => a.year - b.year)[0] ?? null;
  const day1 = goal.settings?.enem_date_override ?? edition?.day1_date ?? null;
  const day2 = edition?.day2_date ?? (day1 ? null : goal.end_date);
  return { edition, day1, day2, provisional: !!goal.settings?.enem_date_override || !edition || edition.dates_status !== 'official' };
}

export interface SimuladoAttempt {
  id: string;
  quiz_id: string;
  status: string;
  finished_at: string | null;
  paused_seconds: number;
  area_results: EnemAreaResults | null;
}

/** Submitted ENEM simulados with TRI results, newest first (ENM-04.9 history). */
export function useSimuladoHistory() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['enem', 'simulados', userId],
    enabled: !!userId,
    queryFn: () =>
      rows<SimuladoAttempt>(
        supabase.from('quiz_attempts').select('id,quiz_id,status,finished_at,paused_seconds,area_results').eq('user_id', userId!).eq('status', 'submitted').not('area_results', 'is', null).order('finished_at', { ascending: false }).limit(30),
      ),
  });
}

export interface EnemEssayRow {
  id: string;
  kind: 'enem_redacao' | 'school_answer';
  theme_id: string | null;
  prompt: { theme?: string; outline?: unknown } | null;
  text: string;
  input_mode: 'typed' | 'photo';
  status: 'draft' | 'grading' | 'graded' | 'failed';
  total: number | null;
  is_zero: boolean | null;
  zero_reasons: string[] | null;
  competencias: Record<string, { id: number; score: number; level_text: string; justification: string; evidence: { quote: string; line: number | null }[]; issues: { type: string; quote: string; line: number | null; fix: string }[]; strengths: string[] }> | null;
  proposta: {
    agente: { present: boolean; quote: string | null };
    acao: { present: boolean; quote: string | null };
    meio: { present: boolean; quote: string | null };
    finalidade: { present: boolean; quote: string | null };
    detalhamento: { present: boolean; quote: string | null };
    direitos_humanos_ok: boolean;
    note: string | null;
  } | null;
  repertorio: Array<{ text: string; kind: string; line: number | null; status: 'confirmed' | 'not_found' | 'contradicted' | 'unverified'; source_url: string | null; source_name: string | null; note: string | null }> | null;
  rewrites: Array<{ paragraph: number; original: string; suggested: string; why: string }> | null;
  feedback: { top_actions?: string[]; zero_evidence?: string | null; too_long?: boolean; calibration?: 'pending' | 'calibrated' } | null;
  line_count: number | null;
  est_handwritten_lines: number | null;
  updated_at: string;
}

export function useEnemEssays() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['enem', 'essays', userId],
    enabled: !!userId,
    queryFn: () => rows<EnemEssayRow>(supabase.from('essays').select('*').eq('user_id', userId!).eq('kind', 'enem_redacao').is('deleted_at', null).order('updated_at', { ascending: false }).limit(50)),
  });
}

export function useEnemEssay(essayId: string | undefined) {
  return useQuery({
    queryKey: ['essay', essayId],
    enabled: !!essayId,
    queryFn: () => row<EnemEssayRow>(supabase.from('essays').select('*').eq('id', essayId!).maybeSingle()),
    refetchInterval: (q) => (q.state.data?.status === 'grading' ? 5000 : false),
  });
}

/** Current estimates s_k (spec 09 §8.4): last 2 simulados per area, last 3 graded essays for RED. */
export function useEstimates() {
  const sims = useSimuladoHistory();
  const essays = useEnemEssays();
  const simulados = (sims.data ?? []).flatMap((a) =>
    Object.entries(a.area_results?.areas ?? {}).map(([area, r]) => ({ area: area as EnemArea, score: r!.score, at: a.finished_at ?? '' })),
  );
  const graded = (essays.data ?? []).filter((e) => e.status === 'graded' && e.total !== null).map((e) => ({ total: e.total!, at: e.updated_at }));
  return { estimates: currentEstimates(simulados, graded), loading: sims.isLoading || essays.isLoading };
}

// ---------------------------------------------------------------- Meta SISU (ENM-06)

export interface SisuOffer {
  id: string;
  edition_year: number;
  institution: string;
  institution_acronym: string | null;
  campus: string | null;
  course: string;
  degree: string | null;
  shift: string | null;
  weights: SisuScores;
  min_scores: Partial<SisuScores>;
  cutoffs: Array<{ modality_label: string; cutoff: number; edition: number }>;
  source: string;
  source_url: string | null;
}

export function useSisuOffers(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['enem', 'sisu_offers', term],
    enabled: term.length >= 3,
    queryFn: () => rows<SisuOffer>(supabase.from('sisu_offers').select('*').or(`course.ilike.%${term.replace(/[%,]/g, '')}%,institution.ilike.%${term.replace(/[%,]/g, '')}%`).limit(30)),
  });
}

export interface SisuTargetRow {
  id: string;
  goal_id: string;
  offer_id: string | null;
  manual: SisuManual | null;
  cutoff_used: number;
  modality_label: string | null;
  margin: number;
  priority: number;
  targets: SisuTargetsJson | null;
  computed_at: string | null;
}

export function useSisuTargets(goalId: string | undefined) {
  return useQuery({
    queryKey: ['enem', 'sisu_targets', goalId],
    enabled: !!goalId,
    queryFn: () => rows<SisuTargetRow>(supabase.from('sisu_targets').select('*').eq('goal_id', goalId!).is('deleted_at', null).order('priority')),
  });
}

/** Targets JSON from the shared math (§8.4); areas without an estimate are listed as missing. */
export function computeTargets(weights: SisuScores, estimates: Partial<SisuScores>, cutoff: number, margin: number, minScores?: Partial<SisuScores>): SisuTargetsJson {
  const missing = (['LC', 'CH', 'CN', 'MT', 'RED'] as const).filter((k) => estimates[k] === undefined);
  if (missing.length > 0) return { status: 'missing_estimates', estimates, current: null, required: cutoff + margin, gap: null, targets: null, display: null, missing };
  const r = sisuTargets({ weights, estimates: estimates as SisuScores, cutoff, margin, ...(minScores ? { minScores } : {}) });
  return { status: r.status, estimates, current: r.current, required: r.required, gap: r.gap, targets: r.targets, display: r.display, missing: [] };
}

export async function saveSisuTarget(
  userId: string,
  input: { goalId: string; existingId?: string | null; offer: SisuOffer | null; manual: SisuManual | null; cutoff: number; margin: number; modalityLabel: string | null; priority: number; targets: SisuTargetsJson },
) {
  const values = {
    offer_id: input.offer?.id ?? null,
    // The weights travel with the target (a snapshot of the offer's), so plans and results read one place.
    manual: input.offer
      ? { label: [input.offer.course, input.offer.institution_acronym ?? input.offer.institution].filter(Boolean).join(' — '), weights: input.offer.weights, min_scores: input.offer.min_scores }
      : input.manual,
    cutoff_used: input.cutoff,
    modality_label: input.modalityLabel,
    margin: input.margin,
    priority: input.priority,
    targets: input.targets,
    computed_at: new Date().toISOString(),
  };
  if (input.existingId) {
    const { error } = await supabase.from('sisu_targets').update(values).eq('id', input.existingId);
    if (error) throw error;
    return input.existingId;
  }
  const id = uuidv7();
  const { error } = await supabase.from('sisu_targets').insert({ id, user_id: userId, goal_id: input.goalId, ...values });
  if (error) throw error;
  return id;
}

export async function deleteSisuTarget(id: string) {
  const { error } = await supabase.from('sisu_targets').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------- Matriz, topics, Prova Provável ENEM

export interface Skill {
  code: string;
  area: EnemArea;
  competency_no: number;
  skill_no: number;
  description: string | null;
}

export function useSkills(area: EnemArea) {
  return useQuery({ queryKey: ['enem', 'skills', area], staleTime: 24 * 60 * 60 * 1000, queryFn: () => rows<Skill>(supabase.from('enem_skills').select('*').eq('area', area).order('skill_no')) });
}

/** Per-skill accuracy from the student's answers to bank and ENEM-style questions of the area (ENM-01.5 grid). */
export function useSkillAccuracy(area: EnemArea) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['enem', 'skill_accuracy', userId, area],
    enabled: !!userId,
    queryFn: async () => {
      const answers = await rows<{ correct: boolean | null; questions: { enem_skill_code: string | null } | null }>(
        supabase.from('attempt_answers').select('correct, questions!inner(enem_skill_code)').eq('user_id', userId!).like('questions.enem_skill_code', `${area}-H%`).limit(2000),
      );
      const out = new Map<string, { n: number; correct: number }>();
      for (const a of answers) {
        const code = a.questions?.enem_skill_code;
        if (!code || a.correct === null) continue;
        const s = out.get(code) ?? { n: 0, correct: 0 };
        s.n += 1;
        if (a.correct) s.correct += 1;
        out.set(code, s);
      }
      return out;
    },
  });
}

export interface TopicTrendRow {
  enem_topic_id: string;
  share_last10: number;
  share_recent5: number;
  share_prev5: number;
  trend: 'up' | 'flat' | 'down';
  predicted_share: number;
  enem_topics: { title: string; subject: string; area: EnemArea } | null;
}

export function useTopicTrends(area: EnemArea) {
  return useQuery({
    queryKey: ['enem', 'trends', area],
    staleTime: 60 * 60 * 1000,
    queryFn: () =>
      rows<TopicTrendRow>(supabase.from('enem_topic_trends').select('*, enem_topics!inner(title, subject, area)').eq('enem_topics.area', area).order('predicted_share', { ascending: false }).limit(80)),
  });
}

export function useTopicStats(topicIds: string[]) {
  return useQuery({
    queryKey: ['enem', 'topic_stats', topicIds.join(',')],
    enabled: topicIds.length > 0,
    queryFn: () => rows<{ enem_topic_id: string; edition_year: number; item_count: number }>(supabase.from('enem_topic_stats').select('enem_topic_id,edition_year,item_count').in('enem_topic_id', topicIds)),
  });
}

// ---------------------------------------------------------------- Bank (ENM-02)

export interface BankItem {
  id: string;
  question_id: string;
  edition_year: number;
  day: 1 | 2;
  area: EnemArea;
  positions: Array<{ co_prova: string; color: string | null; position: number }>;
  answer_key: string | null;
  skill_code: string | null;
  language: 'en' | 'es' | null;
  annulled: boolean;
  crop_paths: string[];
  transcription_md: string | null;
  alt_text: string | null;
  enem_topic_ids: string[];
  subject: string | null;
  questions: { stem: string; difficulty_band: string | null } | null;
}

export interface BankFilters {
  area: EnemArea;
  edition?: number | null;
  skill?: string | null;
  band?: string | null;
  subject?: string | null;
  topicId?: string | null;
  language?: 'en' | 'es';
}

export function useBankItems(f: BankFilters) {
  return useQuery({
    queryKey: ['enem', 'bank', f],
    queryFn: () => {
      let q = supabase.from('enem_items').select('*, questions!inner(stem, difficulty_band)').eq('area', f.area).eq('application', 'regular');
      if (f.edition) q = q.eq('edition_year', f.edition);
      if (f.skill) q = q.eq('skill_code', f.skill);
      if (f.band) q = q.eq('questions.difficulty_band', f.band);
      if (f.subject) q = q.eq('subject', f.subject);
      if (f.topicId) q = q.contains('enem_topic_ids', [f.topicId]);
      if (f.area === 'LC' && f.language) q = q.or(`language.is.null,language.eq.${f.language}`);
      return rows<BankItem>(q.order('edition_year', { ascending: false }).limit(300));
    },
  });
}

export function useBankItem(itemId: string | undefined) {
  return useQuery({
    queryKey: ['enem', 'item', itemId],
    enabled: !!itemId,
    queryFn: () => row<BankItem & { questions: { stem: string; payload: { options: Array<{ id: string; text: string; rationale?: string }>; correct: string }; explanation: string | null; difficulty_band: string | null } }>(
      supabase.from('enem_items').select('*, questions!inner(stem, payload, explanation, difficulty_band)').eq('id', itemId!).maybeSingle(),
    ),
  });
}

/** The student's answers to a set of questions: answered and wrong ids (bank filters "não respondidas", "que errei"). */
export function useAnswered(questionIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['enem', 'answered', userId, questionIds.length, questionIds[0]],
    enabled: !!userId && questionIds.length > 0,
    queryFn: async () => {
      const out = new Map<string, boolean>();
      for (let i = 0; i < questionIds.length; i += 200) {
        const part = await rows<{ question_id: string; correct: boolean | null }>(supabase.from('attempt_answers').select('question_id,correct').eq('user_id', userId!).in('question_id', questionIds.slice(i, i + 200)));
        for (const a of part) out.set(a.question_id, (out.get(a.question_id) ?? false) || a.correct === true);
      }
      return out;
    },
  });
}

/** Bank practice (ENM-02.4): a practice quiz over the chosen official items, untimed or at 3 min/item. */
export async function startBankPractice(userId: string, questionIds: string[], timed: boolean, title: string): Promise<string> {
  const id = uuidv7();
  const { error } = await supabase.from('quizzes').insert({
    id,
    owner_id: userId,
    kind: 'practice',
    mode: timed ? 'exam_conditions' : 'practice',
    title,
    question_ids: questionIds,
    time_limit_s: timed ? questionIds.length * 180 : null,
    scope: { enem: true },
    config: {},
  });
  if (error) throw error;
  return id;
}

/** Signed URLs of item crops (enem bucket, readable by every signed-in student). */
export function useCropUrls(paths: string[] | undefined) {
  return useQuery({
    queryKey: ['enem', 'crops', paths?.join('|')],
    enabled: !!paths && paths.length > 0,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('enem').createSignedUrls(paths!, 3600);
      if (error) throw error;
      return (data ?? []).map((d) => d.signedUrl).filter((u): u is string => !!u);
    },
  });
}

// ---------------------------------------------------------------- Simulados (ENM-04)

export function createSimulado(req: EnemSimuladoCreateReq) {
  return callFunction<EnemSimuladoCreateReq, EnemSimuladoCreateRes>('enem-simulado-create', req, { idempotencyKey: uuidv7() });
}

// ---------------------------------------------------------------- Redação (ENM-05)

export interface EssayTheme {
  id: string;
  title: string;
  axis: string | null;
  source: 'past_enem' | 'predicted' | 'atualidades' | 'custom';
  edition_year: number | null;
  prompt: { instruction?: string; motivating_texts?: Array<{ label: string; text_md: string; source_name: string | null; source_url: string | null }> } | null;
  rationale: string | null;
  valid_until: string | null;
}

export function usePredictedThemes() {
  return useQuery({
    queryKey: ['enem', 'themes', 'predicted'],
    queryFn: () => rows<EssayTheme>(supabase.from('essay_themes').select('*').eq('source', 'predicted').is('deleted_at', null).order('created_at', { ascending: false }).limit(12)),
  });
}

export function usePastThemes() {
  return useQuery({
    queryKey: ['enem', 'themes', 'past'],
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: () => rows<{ edition_year: number; theme: string }>(supabase.from('enem_redacao_themes').select('edition_year,theme').eq('application', 'regular').order('edition_year', { ascending: false })),
  });
}

export function useEssayTheme(themeId: string | undefined) {
  return useQuery({ queryKey: ['enem', 'theme', themeId], enabled: !!themeId, queryFn: () => row<EssayTheme>(supabase.from('essay_themes').select('*').eq('id', themeId!).maybeSingle()) });
}

export function generateTheme(req: EssayThemeGenerateReq) {
  return callFunction<EssayThemeGenerateReq, EssayThemeGenerateRes>('essay-theme-generate', req, { idempotencyKey: uuidv7() });
}

export async function createEnemEssay(userId: string, input: { themeId: string | null; themeTitle: string | null; text: string; inputMode?: 'typed' | 'photo' }): Promise<string> {
  const id = uuidv7();
  const { error } = await supabase.from('essays').insert({
    id,
    user_id: userId,
    kind: 'enem_redacao',
    theme_id: input.themeId,
    // A theme without a row (typed offline) travels in prompt: the grader needs a theme (ENM-05.1).
    prompt: input.themeId ? null : input.themeTitle ? { theme: input.themeTitle } : null,
    text: input.text,
    input_mode: input.inputMode ?? 'typed',
  });
  if (error) throw error;
  return id;
}

export async function updateEssayText(essayId: string, text: string) {
  const { error } = await supabase.from('essays').update({ text }).eq('id', essayId);
  if (error) throw error;
}

// ---------------------------------------------------------------- Atualidades and Repertório (ENM-09, ENM-05.5)

export interface Digest {
  id: string;
  week_start: string;
  status: string;
  published_at: string | null;
}

export interface DigestItem {
  id: string;
  digest_id: string;
  position: number;
  title: string;
  summary_md: string;
  why_md: string;
  areas: string[];
  skill_codes: string[];
  redacao_axes: string[];
  repertorio: Array<{ text: string; source_url: string }>;
  sources: Array<{ url: string; name: string; published_at: string | null }>;
  question_ids: string[];
}

export function useDigests() {
  return useQuery({ queryKey: ['enem', 'digests'], queryFn: () => rows<Digest>(supabase.from('atualidades_digests').select('*').order('week_start', { ascending: false }).limit(30)) });
}

export function useDigestItems(digestId: string | undefined) {
  return useQuery({
    queryKey: ['enem', 'digest', digestId],
    enabled: !!digestId,
    queryFn: () => rows<DigestItem>(supabase.from('atualidades_items').select('*').eq('digest_id', digestId!).order('position')),
  });
}

export interface RepertorioItem {
  id: string;
  kind: 'quote' | 'data' | 'law' | 'work' | 'event';
  text: string;
  source_url: string | null;
  source_name: string | null;
  verified: 'yes' | 'no' | 'contradicted';
  atualidades_item_id: string | null;
  tags: string[];
  created_at: string;
}

export function useRepertorio() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['enem', 'repertorio', userId],
    enabled: !!userId,
    queryFn: () => rows<RepertorioItem>(supabase.from('repertorio_items').select('*').eq('user_id', userId!).is('deleted_at', null).order('created_at', { ascending: false })),
  });
}

export async function saveRepertorio(userId: string, input: { kind: RepertorioItem['kind']; text: string; sourceUrl?: string | null; sourceName?: string | null; atualidadesItemId?: string | null; tags?: string[] }) {
  const { error } = await supabase.from('repertorio_items').insert({
    id: uuidv7(),
    user_id: userId,
    kind: input.kind,
    text: input.text.slice(0, 2000),
    source_url: input.sourceUrl ?? null,
    source_name: input.sourceName ?? null,
    atualidades_item_id: input.atualidadesItemId ?? null,
    tags: input.tags ?? [],
  });
  if (error) throw error;
}

export async function deleteRepertorio(id: string) {
  const { error } = await supabase.from('repertorio_items').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------- Treino de Argumentação (INT-03)

export function startArgument(req: ArgumentStartReq) {
  return callFunction<ArgumentStartReq, ArgumentStartRes>('argument-start', req, { idempotencyKey: uuidv7() });
}

export function sendArgument(sessionId: string, message: string, handlers: StreamHandlers) {
  return streamFunction('argument-turn', { session_id: sessionId, message }, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

export function finishArgument(sessionId: string, createEssay: boolean) {
  return callFunction<{ session_id: string; create_essay: boolean }, ArgumentFinishRes>('argument-finish', { session_id: sessionId, create_essay: createEssay }, { idempotencyKey: uuidv7() });
}

export function suggestArgumentThemes(subjectId: string) {
  return callFunction<{ subject_id: string }, ArgumentThemesRes>('argument-themes', { subject_id: subjectId }, { idempotencyKey: uuidv7() });
}

export interface ArgumentSessionRow {
  id: string;
  goal_mode: 'exam_week' | 'enem';
  subject_id: string | null;
  theme: string;
  theme_id: string | null;
  mode: 'debate' | 'build';
  thesis: string | null;
  thesis_feedback: { clear: boolean; has_position: boolean; specific: boolean; feedback: string; suggestion: string | null } | null;
  rounds: Array<{ user_text: string; opponent_text: string; feedback: { rubric: Record<string, number>; fallacies: Array<{ name: string; quote: string; explanation: string }>; tip: string }; at: string }>;
  round_limit: number;
  rubric: (Record<string, number> & { total: number }) | null;
  summary: Omit<ArgumentFinishRes, 'essay_id'>['summary'] | null;
  outline: ArgumentFinishRes['outline'];
  essay_id: string | null;
  status: 'active' | 'finished' | 'abandoned';
}

export function useArgumentSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['argument', sessionId],
    enabled: !!sessionId,
    queryFn: () =>
      row<ArgumentSessionRow>(
        supabase
          .from('argument_sessions')
          .select('id,goal_mode,subject_id,theme,theme_id,mode,thesis,thesis_feedback,rounds,round_limit,rubric,summary,outline,essay_id,status')
          .eq('id', sessionId!)
          .maybeSingle(),
      ),
  });
}
