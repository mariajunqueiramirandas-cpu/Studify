// enem-simulado-create (ENM-04.1–04.2, ENM-08.4; api §4.9). Builds a TRI-scorable simulado from official items
// only: Réplica (one past edition as applied), Misto (several editions matched to a real edition's difficulty
// mix) or Provável (topic quotas from the predicted shares). Item selection is deterministic code; the chosen ids
// are stored in quizzes.config so the TRI estimate is reproducible (spec 08 §8.5).
import {
  ApiFailure,
  EnemSimuladoCreateReqSchema,
  selectMisto,
  selectProvavel,
  selectReplica,
  simuladoShape,
  type EnemArea,
  type EnemSimuladoConfig,
  type EnemSimuladoCreateReq,
  type EnemSimuladoCreateRes,
} from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { answeredQuestionIds, loadSimuladoPool } from '../shared-p4/enem.ts';

const MODE: Record<EnemSimuladoCreateReq['mode'], 'day1' | 'day2' | 'area' | 'mini'> = { full_day1: 'day1', full_day2: 'day2', area: 'area', mini: 'mini' };

export const handler = defineFunction<EnemSimuladoCreateReq>({
  name: 'enem-simulado-create',
  mutating: true,
  input: EnemSimuladoCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;

    const goal = await db.from('goals').select('id, user_id, mode, status, deleted_at').eq('id', input.goal_id).maybeSingle();
    if (goal.error) throw goal.error;
    if (!goal.data || goal.data.user_id !== userId || goal.data.deleted_at) throw new ApiFailure('not_found');
    if (goal.data.mode !== 'enem') throw new ApiFailure('invalid_request', { message: 'Simulados com TRI são do modo ENEM.' });

    const edition = await db.from('enem_editions').select('day1_duration_min, day2_duration_min').order('year', { ascending: false }).limit(1).maybeSingle();
    if (edition.error) throw edition.error;
    const shape = simuladoShape({
      mode: MODE[input.mode],
      ...(input.area ? { area: input.area } : {}),
      ...(input.mini_size ? { miniSize: input.mini_size } : {}),
      day1Min: (edition.data?.day1_duration_min as number | null) ?? null,
      day2Min: (edition.data?.day2_duration_min as number | null) ?? null,
    });

    const pool = await loadSimuladoPool(db, shape.areas);
    const answered = await answeredQuestionIds(
      db,
      userId,
      pool.map((p) => p.question_id),
    );
    const quizId = deps.newId();
    const seed = `${userId}|${quizId}`;
    const size = shape.itemCount / shape.areas.length;
    let selection;
    if (input.source === 'replica') {
      selection = selectReplica(pool, { areas: shape.areas, edition: input.edition!, language: input.language });
      if (input.mode === 'mini') {
        // A mini réplica keeps the edition's order and takes the first N items of the area.
        const ids = (selection.byArea[shape.areas[0]!] ?? []).slice(0, shape.itemCount);
        const byId = new Map(pool.map((p) => [p.id, p] as const));
        selection = { ...selection, item_ids: ids, question_ids: ids.map((id) => byId.get(id)!.question_id), byArea: { [shape.areas[0]!]: ids } };
      }
    } else if (input.source === 'misto') {
      selection = selectMisto(pool, { areas: shape.areas, size, language: input.language, seed, answered, ...(input.edition ? { referenceEdition: input.edition } : {}) });
    } else {
      const trends = await db.from('enem_topic_trends').select('enem_topic_id, predicted_share');
      if (trends.error) throw trends.error;
      const shares = new Map((trends.data as Array<{ enem_topic_id: string; predicted_share: number }>).map((t) => [t.enem_topic_id, Number(t.predicted_share)] as const));
      selection = selectProvavel(pool, { areas: shape.areas, size, language: input.language, seed, answered, predictedShares: shares, ...(input.edition ? { referenceEdition: input.edition } : {}) });
    }
    if (selection.question_ids.length === 0) {
      throw new ApiFailure('not_found', { message: 'Ainda não há questões oficiais suficientes no banco para esse simulado.' });
    }

    const config: EnemSimuladoConfig = {
      mode: input.mode,
      ...(input.area ? { area: input.area as EnemArea } : {}),
      source: input.source,
      ...(input.edition ? { edition: input.edition } : {}),
      language: input.language,
      item_ids: selection.item_ids,
      time_limit_min: shape.timeLimitMin,
      includes_essay: input.includes_essay ?? shape.includesEssay,
      seed,
      ...(input.source === 'provavel' ? { predicted: true } : {}),
      goal_id: input.goal_id,
    };
    const title =
      input.mode === 'full_day1' ? 'Simulado ENEM — Dia 1' : input.mode === 'full_day2' ? 'Simulado ENEM — Dia 2' : input.mode === 'area' ? `Simulado ENEM — ${input.area}` : `Mini simulado — ${input.area}`;
    const quiz = await db.from('quizzes').insert({
      id: quizId,
      owner_id: userId,
      subject_id: null,
      goal_id: input.goal_id,
      exam_id: null,
      kind: 'enem_simulado',
      mode: 'exam_conditions',
      title,
      question_ids: selection.question_ids,
      time_limit_s: shape.timeLimitMin * 60,
      scope: { enem: true, areas: shape.areas },
      config,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    if (quiz.error) throw quiz.error;
    const attemptId = deps.newId();
    const attempt = await db.from('quiz_attempts').insert({ id: attemptId, user_id: userId, quiz_id: quizId, status: 'in_progress', started_at: ctx.now.toISOString(), device_id: 'server' });
    if (attempt.error) throw attempt.error;

    const body: EnemSimuladoCreateRes = {
      quiz_id: quizId,
      attempt_id: attemptId,
      time_limit_min: shape.timeLimitMin,
      item_count: selection.question_ids.length,
      ...(Object.keys(selection.shortfall).length ? { shortfall: selection.shortfall as Record<string, number> } : {}),
    };
    return ctx.json(body, 201);
  },
});

export default handler;
