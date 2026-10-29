// Data endpoints of apps/mobile/src/features/enem (define.ts explains the contract): editions, simulado history,
// essays, Meta SISU, the Matriz grid, Prova Provável trends, the official bank, themes, Atualidades, repertório and
// the Treino de Argumentação session. The ENEM wizard's language choice (app/enem/new.tsx) is here too.
import { z } from 'zod';
import { toDbError, type Db } from '@studify/db';
import { dataRoute, dbFailure, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const Area = z.enum(['LC', 'CH', 'CN', 'MT']);
const JsonObject = z.record(z.string(), z.unknown());

/** A joined read (db.select) with the database error mapped like the query builder's. */
async function sql<T = any>(db: Db, text: string, values: unknown[], what: string): Promise<T[]> {
  try {
    return (await db.select(text, values)) as T[];
  } catch (err) {
    throw dbFailure(toDbError(err), what);
  }
}

const BANK_ITEM_JOIN = `from public.enem_items i join public.questions q on q.id = i.question_id`;

export const routes: DataRoute[] = [
  dataRoute({
    name: 'enem-editions',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db }) => rows(db.from('enem_editions').select('*').order('year')),
  }),

  dataRoute({
    name: 'enem-simulados',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) =>
      rows(
        db
          .from('quiz_attempts')
          .select('id,quiz_id,status,finished_at,paused_seconds,area_results')
          .eq('user_id', user.userId)
          .eq('status', 'submitted')
          .not('area_results', 'is', null)
          .order('finished_at', { ascending: false })
          .limit(30),
      ),
  }),

  dataRoute({
    name: 'enem-essays',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) =>
      rows(db.from('essays').select('*').eq('user_id', user.userId).eq('kind', 'enem_redacao').is('deleted_at', null).order('updated_at', { ascending: false }).limit(50)),
  }),

  dataRoute({
    name: 'enem-essay-get',
    write: false,
    input: z.object({ essay_id: Id }),
    example: (seed) => ({ essay_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('essays').select('*').eq('id', input.essay_id).maybeSingle()),
  }),

  dataRoute({
    name: 'enem-essay-create',
    write: true,
    input: z.object({
      id: Id,
      theme_id: Id.nullable(),
      theme_title: z.string().max(500).nullable(),
      text: z.string().max(20_000),
      input_mode: z.enum(['typed', 'photo']).optional(),
    }),
    example: () => ({ id: crypto.randomUUID(), theme_id: null, theme_title: 'Desafios da mobilidade urbana', text: 'Rascunho.' }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('essays').insert({
          id: input.id,
          user_id: user.userId,
          kind: 'enem_redacao',
          theme_id: input.theme_id,
          // A theme without a row (typed offline) travels in prompt: the grader needs a theme (ENM-05.1).
          prompt: input.theme_id ? null : input.theme_title ? { theme: input.theme_title } : null,
          text: input.text,
          input_mode: input.input_mode ?? 'typed',
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'enem-essay-update-text',
    write: true,
    input: z.object({ essay_id: Id, text: z.string().max(20_000) }),
    example: (seed) => ({ essay_id: seed.missingId, text: 'Texto.' }),
    run: async ({ db, input }) => {
      await done(db.from('essays').update({ text: input.text }).eq('id', input.essay_id));
      return { ok: true };
    },
  }),

  // ------------------------------------------------------------ Meta SISU (ENM-06)

  dataRoute({
    name: 'enem-sisu-offers',
    write: false,
    input: z.object({ q: z.string().trim().min(3).max(120) }),
    example: () => ({ q: 'Medicina' }),
    run: ({ db, input }) => {
      // course ilike %term% or institution ilike %term% (the app's or-filter), with the term as a parameter.
      const pattern = `%${input.q.replace(/[%,]/g, '')}%`;
      return sql(db, `select * from public.sisu_offers where course ilike $1 or institution ilike $1 limit 30`, [pattern], 'sisu_offers');
    },
  }),

  dataRoute({
    name: 'enem-sisu-targets',
    write: false,
    input: z.object({ goal_id: Id }),
    example: (seed) => ({ goal_id: seed.goalId }),
    run: ({ db, input }) => rows(db.from('sisu_targets').select('*').eq('goal_id', input.goal_id).is('deleted_at', null).order('priority')),
  }),

  dataRoute({
    name: 'enem-sisu-target-save',
    write: true,
    input: z.object({
      id: Id,
      /** True: update the target `id`; false: create it under `goal_id`. */
      existing: z.boolean(),
      goal_id: Id,
      offer_id: Id.nullable(),
      manual: JsonObject.nullable(),
      cutoff_used: z.number().finite().min(0).max(1000),
      modality_label: z.string().max(60).nullable(),
      margin: z.number().finite().min(0).max(200),
      priority: z.number().int().min(1).max(3),
      targets: JsonObject.nullable(),
    }),
    example: (seed) => ({
      id: crypto.randomUUID(),
      existing: false,
      goal_id: seed.goalId,
      offer_id: null,
      manual: { label: 'Medicina — UFX', weights: { LC: 1, CH: 1, CN: 2, MT: 2, RED: 1 } },
      cutoff_used: 750,
      modality_label: null,
      margin: 10,
      priority: 1,
      targets: null,
    }),
    run: async ({ db, user, input, now }) => {
      const values = {
        offer_id: input.offer_id,
        manual: input.manual,
        cutoff_used: input.cutoff_used,
        modality_label: input.modality_label,
        margin: input.margin,
        priority: input.priority,
        targets: input.targets,
        computed_at: now.toISOString(),
      };
      if (input.existing) {
        await done(db.from('sisu_targets').update(values).eq('id', input.id));
      } else {
        await done(db.from('sisu_targets').insert({ id: input.id, user_id: user.userId, goal_id: input.goal_id, ...values }));
      }
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'enem-sisu-target-delete',
    write: true,
    input: z.object({ id: Id }),
    example: (seed) => ({ id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('sisu_targets').update({ deleted_at: now.toISOString() }).eq('id', input.id));
      return { ok: true };
    },
  }),

  // ------------------------------------------------------------ Matriz, topics, Prova Provável ENEM

  dataRoute({
    name: 'enem-skills',
    write: false,
    input: z.object({ area: Area }),
    example: () => ({ area: 'MT' as const }),
    run: ({ db, input }) => rows(db.from('enem_skills').select('*').eq('area', input.area).order('skill_no')),
  }),

  dataRoute({
    name: 'enem-skill-accuracy',
    write: false,
    input: z.object({ area: Area }),
    example: () => ({ area: 'MT' as const }),
    // The student's answers joined to their question's ENEM skill (attempt_answers + questions!inner).
    run: ({ db, user, input }) =>
      sql<{ correct: boolean | null; enem_skill_code: string }>(
        db,
        `select a.correct, q.enem_skill_code
           from public.attempt_answers a
           join public.questions q on q.id = a.question_id
          where a.user_id = $1 and q.enem_skill_code like $2
          limit 2000`,
        [user.userId, `${input.area}-H%`],
        'attempt_answers',
      ),
  }),

  dataRoute({
    name: 'enem-trends',
    write: false,
    input: z.object({ area: Area }),
    example: () => ({ area: 'CN' as const }),
    run: ({ db, input }) =>
      sql(
        db,
        `select t.*, json_build_object('title', e.title, 'subject', e.subject, 'area', e.area) as enem_topics
           from public.enem_topic_trends t
           join public.enem_topics e on e.id = t.enem_topic_id
          where e.area = $1
          order by t.predicted_share desc
          limit 80`,
        [input.area],
        'enem_topic_trends',
      ),
  }),

  dataRoute({
    name: 'enem-topic-stats',
    write: false,
    input: z.object({ topic_ids: z.array(Id).max(500) }),
    example: (seed) => ({ topic_ids: [seed.missingId] }),
    run: async ({ db, input }) =>
      input.topic_ids.length === 0 ? [] : rows(db.from('enem_topic_stats').select('enem_topic_id,edition_year,item_count').in('enem_topic_id', input.topic_ids)),
  }),

  // ------------------------------------------------------------ Bank (ENM-02)

  dataRoute({
    name: 'enem-bank-items',
    write: false,
    input: z.object({
      area: Area,
      edition: z.number().int().min(1998).max(2100).nullable().optional(),
      skill: z.string().max(20).nullable().optional(),
      band: z.string().max(40).nullable().optional(),
      subject: z.string().max(80).nullable().optional(),
      topic_id: Id.nullable().optional(),
      language: z.enum(['en', 'es']).optional(),
    }),
    example: () => ({ area: 'LC' as const, edition: 2023, language: 'en' as const }),
    run: ({ db, input }) => {
      const values: unknown[] = [input.area];
      const where = [`i.area = $1`, `i.application = 'regular'`];
      const add = (cond: (p: string) => string, value: unknown) => {
        values.push(value);
        where.push(cond(`$${values.length}`));
      };
      if (input.edition) add((p) => `i.edition_year = ${p}`, input.edition);
      if (input.skill) add((p) => `i.skill_code = ${p}`, input.skill);
      if (input.band) add((p) => `q.difficulty_band = ${p}`, input.band);
      if (input.subject) add((p) => `i.subject = ${p}`, input.subject);
      if (input.topic_id) add((p) => `i.enem_topic_ids @> array[${p}::uuid]`, input.topic_id);
      if (input.area === 'LC' && input.language) add((p) => `(i.language is null or i.language = ${p})`, input.language);
      return sql(
        db,
        `select i.*, json_build_object('stem', q.stem, 'difficulty_band', q.difficulty_band) as questions
           ${BANK_ITEM_JOIN}
          where ${where.join(' and ')}
          order by i.edition_year desc
          limit 300`,
        values,
        'enem_items',
      );
    },
  }),

  dataRoute({
    name: 'enem-bank-item',
    write: false,
    input: z.object({ item_id: Id }),
    example: (seed) => ({ item_id: seed.missingId }),
    run: async ({ db, input }) => {
      const found = await sql(
        db,
        `select i.*, json_build_object('stem', q.stem, 'payload', q.payload, 'explanation', q.explanation, 'difficulty_band', q.difficulty_band) as questions
           ${BANK_ITEM_JOIN}
          where i.id = $1`,
        [input.item_id],
        'enem_items',
      );
      return found[0] ?? null;
    },
  }),

  dataRoute({
    name: 'enem-answered',
    write: false,
    input: z.object({ question_ids: z.array(Id).max(1000) }),
    example: (seed) => ({ question_ids: [seed.missingId] }),
    run: async ({ db, user, input }) => {
      // In parts of 200, as the app read them (each part under the row cap).
      const out: Array<{ question_id: string; correct: boolean | null }> = [];
      for (let i = 0; i < input.question_ids.length; i += 200) {
        out.push(...(await rows(db.from('attempt_answers').select('question_id,correct').eq('user_id', user.userId).in('question_id', input.question_ids.slice(i, i + 200)))));
      }
      return out;
    },
  }),

  dataRoute({
    name: 'enem-practice-start',
    write: true,
    input: z.object({ id: Id, question_ids: z.array(Id).max(500), timed: z.boolean(), title: z.string().max(300) }),
    example: () => ({ id: crypto.randomUUID(), question_ids: [], timed: false, title: 'ENEM — Matemática' }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('quizzes').insert({
          id: input.id,
          owner_id: user.userId,
          kind: 'practice',
          mode: input.timed ? 'exam_conditions' : 'practice',
          title: input.title,
          question_ids: input.question_ids,
          time_limit_s: input.timed ? input.question_ids.length * 180 : null,
          scope: { enem: true },
          config: {},
        }),
      );
      return { id: input.id };
    },
  }),

  // ------------------------------------------------------------ Redação (ENM-05)

  dataRoute({
    name: 'enem-themes-predicted',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db }) => rows(db.from('essay_themes').select('*').eq('source', 'predicted').is('deleted_at', null).order('created_at', { ascending: false }).limit(12)),
  }),

  dataRoute({
    name: 'enem-themes-past',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db }) => rows(db.from('enem_redacao_themes').select('edition_year,theme').eq('application', 'regular').order('edition_year', { ascending: false })),
  }),

  dataRoute({
    name: 'enem-theme-get',
    write: false,
    input: z.object({ theme_id: Id }),
    example: (seed) => ({ theme_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('essay_themes').select('*').eq('id', input.theme_id).maybeSingle()),
  }),

  // ------------------------------------------------------------ Atualidades and Repertório (ENM-09, ENM-05.5)

  dataRoute({
    name: 'enem-digests',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db }) => rows(db.from('atualidades_digests').select('*').order('week_start', { ascending: false }).limit(30)),
  }),

  dataRoute({
    name: 'enem-digest-items',
    write: false,
    input: z.object({ digest_id: Id }),
    example: (seed) => ({ digest_id: seed.missingId }),
    run: ({ db, input }) => rows(db.from('atualidades_items').select('*').eq('digest_id', input.digest_id).order('position')),
  }),

  dataRoute({
    name: 'enem-repertorio',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('repertorio_items').select('*').eq('user_id', user.userId).is('deleted_at', null).order('created_at', { ascending: false })),
  }),

  dataRoute({
    name: 'enem-repertorio-save',
    write: true,
    input: z.object({
      id: Id,
      kind: z.enum(['quote', 'data', 'law', 'work', 'event']),
      text: z.string().min(1).max(2000),
      source_url: z.string().max(2000).nullable().optional(),
      source_name: z.string().max(300).nullable().optional(),
      atualidades_item_id: Id.nullable().optional(),
      tags: z.array(z.string().max(120)).max(50).optional(),
    }),
    example: () => ({ id: crypto.randomUUID(), kind: 'quote' as const, text: 'A educação é a arma mais poderosa.', source_url: null }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('repertorio_items').insert({
          id: input.id,
          user_id: user.userId,
          kind: input.kind,
          text: input.text,
          source_url: input.source_url ?? null,
          source_name: input.source_name ?? null,
          atualidades_item_id: input.atualidades_item_id ?? null,
          tags: input.tags ?? [],
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'enem-repertorio-delete',
    write: true,
    input: z.object({ id: Id }),
    example: (seed) => ({ id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('repertorio_items').update({ deleted_at: now.toISOString() }).eq('id', input.id));
      return { ok: true };
    },
  }),

  // ------------------------------------------------------------ Treino de Argumentação (INT-03)

  dataRoute({
    name: 'enem-argument-session',
    write: false,
    input: z.object({ session_id: Id }),
    example: (seed) => ({ session_id: seed.missingId }),
    run: ({ db, input }) =>
      maybe(
        db
          .from('argument_sessions')
          .select('id,goal_mode,subject_id,theme,theme_id,mode,thesis,thesis_feedback,rounds,round_limit,rubric,summary,outline,essay_id,status')
          .eq('id', input.session_id)
          .maybeSingle(),
      ),
  }),

  // ------------------------------------------------------------ ENEM goal wizard (app/enem/new.tsx)

  dataRoute({
    name: 'enem-set-language',
    write: true,
    input: z.object({ language: z.enum(['en', 'es']) }),
    example: () => ({ language: 'en' as const }),
    run: async ({ db, user, input }) => {
      await done(db.from('profiles').update({ foreign_language: input.language }).eq('id', user.userId));
      return { ok: true };
    },
  }),
];
