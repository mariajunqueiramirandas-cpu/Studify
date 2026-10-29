// Trust jobs (TRU-02, spec 10 §7.1, §8.6): flag.triage verifies a reported item against its source
// pages; flag.apply_fix publishes an accepted correction as a new item version and propagates it.
import { z } from 'zod';
import { gradeAnswer, parseQuestionPayload, parseQuestionResponse } from '@studify/shared';
import { flagTriage, FlagVerdict, type FlagTriageInput, type PdfSlice } from '@studify/prompts';
import type { OperationContext, OperationDefinition } from '../framework/types.ts';
import { pagesAllowed, runPrompt, documentIdForLabel, type AiScope } from '../lib/ai-adapter.ts';
import { JobDataError, chunk, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { loadDocument, slicesFor } from '../lib/documents.ts';
import { ensureOpenMistake } from '../lib/mistakes.ts';
import { localDateOf } from '../lib/time.ts';

const TriagePayload = z.object({ flag_id: z.string().min(1) });
const ApplyPayload = z.object({ flag_id: z.string().min(1) });

type ItemType = 'card' | 'question' | 'note' | 'glossary' | 'feed_item' | 'tutor_answer';

interface ItemSpec {
  table: string;
  kind: FlagTriageInput['item']['kind'];
  /** Fields the item shows to the verdict (JSON fields are sent as JSON text). */
  fields: string[];
  jsonFields: string[];
  /** Fields a verdict or an accepted fix may change. */
  editable: string[];
  nodeField: string | null;
  pagesField: string;
}

export const ITEM_SPECS: Record<ItemType, ItemSpec> = {
  card: { table: 'cards', kind: 'card', fields: ['front', 'back'], jsonFields: [], editable: ['front', 'back'], nodeField: 'node_id', pagesField: 'source_pages' },
  question: { table: 'questions', kind: 'question', fields: ['stem', 'explanation', 'payload'], jsonFields: ['payload'], editable: ['stem', 'explanation', 'payload'], nodeField: 'node_id', pagesField: 'source_pages' },
  note: { table: 'notes', kind: 'note', fields: ['body'], jsonFields: [], editable: ['body'], nodeField: 'node_id', pagesField: 'citations' },
  glossary: { table: 'glossary_terms', kind: 'glossary', fields: ['term', 'definition', 'example'], jsonFields: [], editable: ['term', 'definition', 'example'], nodeField: 'node_id', pagesField: 'source_pages' },
  feed_item: { table: 'feed_items', kind: 'feed_item', fields: ['content'], jsonFields: ['content'], editable: ['content'], nodeField: 'node_id', pagesField: 'source_pages' },
  tutor_answer: { table: 'tutor_messages', kind: 'tutor_answer', fields: ['content'], jsonFields: [], editable: ['content'], nodeField: null, pagesField: 'citations' },
};

/** Reason labels of TRU-02.2 (the form stores the data-model values; the prompt takes the PT-BR labels). */
export function reasonLabel(reason: string): FlagTriageInput['reason'] {
  switch (reason) {
    case 'Informação errada':
    case 'Gabarito errado':
    case 'Confuso':
    case 'Não está no material':
    case 'Erro de digitação/formatação':
    case 'Conteúdo impróprio':
    case 'Outro':
      return reason;
    case 'wrong_answer':
      return 'Gabarito errado';
    case 'wrong_fact':
      return 'Informação errada';
    case 'wrong_page':
      return 'Não está no material';
    case 'unclear':
      return 'Confuso';
    case 'inappropriate':
      return 'Conteúdo impróprio';
    default:
      return 'Outro';
  }
}

interface FlagRow {
  id: string;
  item_type: string;
  item_id: string;
  item_version: number;
  class_group_id: string | null;
  reporter_id: string;
  reason: string;
  comment: string | null;
  status: string;
  ai_proposed_fix: { fields: Array<{ name: string; value: string }>; answer_changed: boolean } | null;
  resolved_by: string | null;
}

interface PageRef {
  document_id: string;
  page_start: number;
  page_end: number;
}

/** Reporter weight (TRU-02.10): reports from a user whose last 10 were all rejected count 0 for auto-hide. */
export async function reporterWeight(ctx: OperationContext, reporterId: string): Promise<number> {
  const recent = unwrapRows<{ status: string }>(
    await ctx.supabase.from('content_flags').select('status').eq('reporter_id', reporterId).order('created_at', { ascending: false }).limit(10),
    'content_flags',
  );
  return recent.length === 10 && recent.every((r) => r.status === 'rejected') ? 0 : 1;
}

async function loadItem(ctx: OperationContext, spec: ItemSpec, id: string): Promise<Record<string, unknown> | null> {
  return unwrap(await ctx.supabase.from(spec.table).select('*').eq('id', id).maybeSingle(), spec.table) as Record<string, unknown> | null;
}

function pageRefsOf(item: Record<string, unknown>, spec: ItemSpec): PageRef[] {
  const raw = item[spec.pagesField];
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is PageRef => typeof r === 'object' && r !== null && typeof (r as PageRef).document_id === 'string' && typeof (r as PageRef).page_start === 'number' && typeof (r as PageRef).page_end === 'number');
}

/**
 * Validates a corrected item: only editable field names, JSON fields parse, and question payloads pass
 * the shared QuestionPayload schema. Returns the column patch, or null when the fix is unusable.
 */
export function fixPatch(spec: ItemSpec, fields: ReadonlyArray<{ name: string; value: string }>, questionType?: string): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (!spec.editable.includes(f.name)) return null;
    if (spec.jsonFields.includes(f.name)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.value);
      } catch {
        return null;
      }
      if (f.name === 'payload' && questionType) {
        try {
          parseQuestionPayload(questionType as Parameters<typeof parseQuestionPayload>[0], parsed);
        } catch {
          return null;
        }
      }
      patch[f.name] = parsed;
    } else {
      patch[f.name] = f.value;
    }
  }
  return patch;
}

export interface TriageOutcome {
  status: 'triaged' | 'skipped' | 'superseded';
  verdict?: string;
  hidden?: boolean;
  moderatorsNotified?: number;
}

/** flag.triage (TRU-02.4): AI verdict with page-checked evidence, then auto-hide and moderator notice. */
export async function handleFlagTriage(ctx: OperationContext, data: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'TRU-02.4' }): Promise<TriageOutcome> {
  const payload = TriagePayload.parse(data);
  const flag = unwrap(await ctx.supabase.from('content_flags').select('*').eq('id', payload.flag_id).maybeSingle(), 'content_flags') as FlagRow | null;
  if (!flag) return { status: 'skipped' };
  if (flag.status !== 'open') return { status: 'skipped' };
  const spec = ITEM_SPECS[flag.item_type as ItemType];
  if (!spec) {
    unwrap(await ctx.supabase.from('content_flags').update({ status: 'triaged', ai_verdict: 'unsure', ai_explanation: 'Tipo de item sem triagem automática.' }).eq('id', flag.id), 'content_flags');
    return { status: 'triaged', verdict: 'unclear' };
  }
  const item = await loadItem(ctx, spec, flag.item_id);
  if (!item) {
    unwrap(await ctx.supabase.from('content_flags').update({ status: 'superseded' }).eq('id', flag.id), 'content_flags');
    return { status: 'superseded' };
  }
  if (Number(item.version ?? 1) !== flag.item_version) {
    unwrap(await ctx.supabase.from('content_flags').update({ status: 'superseded' }).eq('id', flag.id), 'content_flags');
    return { status: 'superseded' };
  }

  // Evidence: slices of up to three documents the item cites (TRU-02.4, document blocks cached per slice).
  const refs = pageRefsOf(item, spec);
  const byDoc = new Map<string, number[]>();
  for (const r of refs) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), ...rangeOf(r.page_start, r.page_end)]);
  const slices: PdfSlice[] = [];
  for (const docId of [...byDoc.keys()].slice(0, 3)) {
    const doc = await loadDocument(ctx, docId);
    slices.push(...(await slicesFor(ctx, doc, uniq(byDoc.get(docId) ?? []).sort((a, b) => a - b))));
  }
  const node = spec.nodeField ? (item[spec.nodeField] as string | null) : null;
  const summary = node
    ? unwrap(await ctx.supabase.from('knowledge_nodes').select('title,summary').eq('id', node).maybeSingle(), 'knowledge_nodes') as { title: string; summary: string | null } | null
    : null;
  const subject = unwrap(await ctx.supabase.from('subjects').select('content_language').eq('id', String(item.subject_id ?? '')).maybeSingle(), 'subjects') as { content_language: string | null } | null;

  const fields = spec.fields.filter((f) => item[f] !== undefined).map((f) => ({
    name: f,
    value: spec.jsonFields.includes(f) ? JSON.stringify(item[f]) : String(item[f] ?? ''),
  }));
  const input: FlagTriageInput = {
    item: { kind: spec.kind, fields, editableFields: spec.editable },
    reason: reasonLabel(flag.reason),
    comment: flag.comment,
    slices,
    topicSummary: summary ? `${summary.title}${summary.summary ? `: ${summary.summary}` : ''}` : '',
    contentLanguage: subject?.content_language ?? 'pt-BR',
  };
  const outcome = await runPrompt(ctx.ai, {
    task: flagTriage,
    schema: FlagVerdict,
    input,
    scope: { ...scope, userId: flag.reporter_id, classGroupId: flag.class_group_id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') throw new JobDataError(`flag.triage ${outcome.result.status}`, 'ai_failed');

  // Server checks (ai-pipeline §5): evidence pages must be inside the slices sent; a fix may only touch
  // editable fields, and question payloads must validate. Anything else becomes "unclear".
  const verdict = outcome.result.data;
  let verdictName = verdict.verdict;
  let confidence = verdict.confidence;
  const evidence = verdict.evidence_pages.filter((p) => pagesAllowed(outcome.documents, p.doc, p.page_start, p.page_end));
  let fix: { fields: Array<{ name: string; value: string }>; answer_changed: boolean } | null = null;
  if (verdict.evidence_pages.length !== evidence.length) {
    verdictName = 'unclear';
    confidence = 'low';
  }
  if (verdictName === 'error_confirmed' && verdict.corrected_item) {
    const patch = fixPatch(spec, verdict.corrected_item.fields, item.type as string | undefined);
    if (patch) fix = { fields: verdict.corrected_item.fields, answer_changed: verdict.answer_changed };
    else {
      verdictName = 'unclear';
      confidence = 'low';
    }
  }
  const sourcePages = evidence
    .map((p) => {
      const documentId = documentIdForLabel(outcome.documents, p.doc);
      return documentId ? { document_id: documentId, page_start: p.page_start, page_end: p.page_end } : null;
    })
    .filter((p): p is PageRef => p !== null);
  const aiVerdict = verdictName === 'error_confirmed' ? 'confirmed' : verdictName === 'not_an_error' ? 'rejected' : 'unsure';

  const weight = await reporterWeight(ctx, flag.reporter_id);
  unwrap(
    await ctx.supabase
      .from('content_flags')
      .update({
        ai_verdict: aiVerdict,
        ai_confidence: confidence,
        ai_explanation: verdict.explanation_pt,
        ai_source_pages: sourcePages,
        ai_proposed_fix: fix,
        reporter_weight: weight,
        status: 'triaged',
      })
      .eq('id', flag.id)
      .eq('status', 'open'),
    'content_flags update',
  );

  // Auto-hide (TRU-02.7): ≥ 3 distinct reporters of the same version, or a confident error on a wrong-answer / wrong-info report.
  let hidden = false;
  let moderatorsNotified = 0;
  if (flag.class_group_id) {
    const group = unwrapRows<{ reporter_id: string; reporter_weight: number }>(
      await ctx.supabase
        .from('content_flags')
        .select('reporter_id,reporter_weight')
        .eq('item_type', flag.item_type)
        .eq('item_id', flag.item_id)
        .eq('item_version', flag.item_version)
        .in('status', ['open', 'triaged', 'hidden_pending']),
      'content_flags',
    );
    const reporters = new Set(group.filter((g) => Number(g.reporter_weight) > 0).map((g) => g.reporter_id));
    const confidentError = aiVerdict === 'confirmed' && confidence === 'high' && (flag.reason === 'Gabarito errado' || flag.reason === 'Informação errada' || flag.reason === 'wrong_answer' || flag.reason === 'wrong_fact');
    if (reporters.size >= 3 || confidentError) {
      hidden = true;
      unwrap(await ctx.supabase.from(spec.table).update({ hidden_reason: 'under_review' }).eq('id', flag.item_id), spec.table);
      unwrap(
        await ctx.supabase
          .from('content_flags')
          .update({ status: 'hidden_pending' })
          .eq('item_type', flag.item_type)
          .eq('item_id', flag.item_id)
          .eq('item_version', flag.item_version)
          .in('status', ['open', 'triaged']),
        'content_flags',
      );
      await ctx.db.query(
        'insert into private.moderation_actions (actor_kind, action, target_type, target_id, reason, flag_id) values ($1, $2, $3, $4, $5, $6)',
        ['system', 'hide', flag.item_type, flag.item_id, 'auto_hide_tru_02_7', flag.id],
      );
    }
    const moderators = unwrapRows<{ user_id: string }>(
      await ctx.supabase.from('class_group_members').select('user_id').eq('class_group_id', flag.class_group_id).in('role', ['owner', 'moderator']).eq('status', 'active'),
      'class_group_members',
    );
    for (const m of moderators) {
      await ctx.execute(
        'notify.dispatch',
        { user_id: m.user_id, type: 'content_flag_review', data: { class_group_id: flag.class_group_id, flag_id: flag.id, item_type: flag.item_type, item_id: flag.item_id } },
        { singletonKey: `flag-review:${flag.id}:${m.user_id}` },
      );
      moderatorsNotified++;
    }
  }
  return { status: 'triaged', verdict: verdictName, hidden, moderatorsNotified };
}

function rangeOf(start: number, end: number): number[] {
  const out: number[] = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

export interface ApplyOutcome {
  status: 'applied' | 'skipped';
  reason?: string;
  version?: number;
  regraded?: number;
  affectedUsers?: number;
}

const AUTO_GRADABLE = ['mcq_single', 'multi_select', 'true_false', 'fill_blank', 'numeric', 'matching', 'ordering'] as const;
const ACTIVE_QUIZ_KINDS_EXCLUDED = ['duel', 'battle'];

/**
 * flag.apply_fix: writes the accepted fix as version v+1 (item_revisions), then propagates it: card
 * answers reset for users who reviewed the card, question answers re-graded (duel and battle results are
 * never re-scored, §8.6), Caderno entries added or removed, affected users notified once per day.
 */
export async function handleFlagApply(ctx: OperationContext, data: Record<string, unknown>): Promise<ApplyOutcome> {
  const payload = ApplyPayload.parse(data);
  const flag = unwrap(await ctx.supabase.from('content_flags').select('*').eq('id', payload.flag_id).maybeSingle(), 'content_flags') as FlagRow | null;
  if (!flag || flag.status !== 'accepted' || !flag.ai_proposed_fix) return { status: 'skipped', reason: 'not_accepted' };
  const spec = ITEM_SPECS[flag.item_type as ItemType];
  if (!spec) return { status: 'skipped', reason: 'unsupported_type' };
  const already = unwrapRows<{ id: string }>(await ctx.supabase.from('item_revisions').select('id').eq('flag_id', flag.id), 'item_revisions');
  if (already.length > 0) return { status: 'skipped', reason: 'already_applied' };

  const item = await loadItem(ctx, spec, flag.item_id);
  if (!item || Number(item.version ?? 1) !== flag.item_version) return { status: 'skipped', reason: 'version_moved' };
  const questionType = typeof item.type === 'string' ? item.type : undefined;
  const patch = fixPatch(spec, flag.ai_proposed_fix.fields, questionType);
  if (!patch) return { status: 'skipped', reason: 'invalid_fix' };

  const newVersion = flag.item_version + 1;
  const applied = unwrapRows<{ id: string }>(
    await ctx.supabase.from(spec.table).update({ ...patch, version: newVersion, hidden_reason: null }).eq('id', flag.item_id).eq('version', flag.item_version).select('id'),
    spec.table,
  );
  if (applied.length === 0) return { status: 'skipped', reason: 'concurrent_update' };
  const snapshot = { ...item, ...patch, version: newVersion, hidden_reason: null };
  unwrap(
    await ctx.supabase.from('item_revisions').insert({
      item_type: flag.item_type,
      item_id: flag.item_id,
      version: newVersion,
      content: snapshot,
      changed_by: flag.resolved_by,
      flag_id: flag.id,
      answer_changed: flag.ai_proposed_fix.answer_changed,
    }),
    'item_revisions',
  );

  const affected = new Set<string>();
  let regraded = 0;
  if (flag.item_type === 'card' && flag.ai_proposed_fix.answer_changed) {
    const reset = unwrapRows<{ user_id: string }>(
      await ctx.supabase
        .from('card_states')
        .update({ state: 0, reps: 0, lapses: 0, stability: 0, difficulty: 0, scheduled_days: 0, learning_steps: 0, due: ctx.now().toISOString(), last_review: null, introduced_at: null, is_leech: false })
        .eq('card_id', flag.item_id)
        .gt('reps', 0)
        .select('user_id'),
      'card_states',
    );
    for (const r of reset) affected.add(r.user_id);
  }
  if (flag.item_type === 'question' && flag.ai_proposed_fix.answer_changed) {
    const question = unwrap(await ctx.supabase.from('questions').select('id,type,payload,node_id').eq('id', flag.item_id).maybeSingle(), 'questions') as { id: string; type: string; payload: unknown; node_id: string } | null;
    if (question && (AUTO_GRADABLE as readonly string[]).includes(question.type)) {
      const answers = unwrapRows<{ id: string; user_id: string; attempt_id: string; response: unknown; correct: boolean | null; score: number | null; points_max: number | null }>(
        await ctx.supabase.from('attempt_answers').select('id,user_id,attempt_id,response,correct,score,points_max').eq('question_id', question.id).not('correct', 'is', null),
        'attempt_answers',
      );
      const quizzes = await quizKindsOf(ctx, uniq(answers.map((a) => a.attempt_id)));
      const today = localDateOf(ctx.now(), 'America/Sao_Paulo');
      const qtype = question.type as Parameters<typeof gradeAnswer>[0];
      for (const a of answers) {
        if (ACTIVE_QUIZ_KINDS_EXCLUDED.includes(quizzes.get(a.attempt_id) ?? '')) continue;
        let result: ReturnType<typeof gradeAnswer>;
        try {
          const response = parseQuestionResponse(qtype, a.response);
          const newPayload = 'payload' in patch ? patch.payload : item.payload;
          result = gradeAnswer(qtype, parseQuestionPayload(qtype, newPayload), response);
        } catch {
          continue;
        }
        if (result.pending || result.score === null) continue;
        const changed = Boolean(a.correct) !== Boolean(result.correct);
        unwrap(
          await ctx.supabase
            .from('attempt_answers')
            .update({ correct: result.correct, score: result.score, points_awarded: round2((result.score ?? 0) * (a.points_max ?? 1)), question_version: newVersion })
            .eq('id', a.id),
          'attempt_answers',
        );
        regraded++;
        if (!changed) continue;
        affected.add(a.user_id);
        if (result.correct) {
          unwrap(
            await ctx.supabase.from('mistakes').update({ deleted_at: ctx.now().toISOString() }).eq('user_id', a.user_id).eq('question_id', question.id).eq('attempt_answer_id', a.id).is('resolved_at', null).is('deleted_at', null),
            'mistakes',
          );
        } else {
          const subject = unwrap(await ctx.supabase.from('questions').select('subject_id').eq('id', question.id).maybeSingle(), 'questions') as { subject_id: string } | null;
          await ensureOpenMistake(ctx, {
            userId: a.user_id,
            questionId: question.id,
            attemptAnswerId: a.id,
            subjectId: subject?.subject_id ?? '',
            nodeId: question.node_id,
            cause: 'didnt_know',
            today,
            remediationCardId: null,
          });
        }
        await ctx.execute('mastery.recompute', { user_id: a.user_id, node_ids: [question.node_id] }, { singletonKey: `mastery.recompute:${a.user_id}` });
      }
    }
  }

  unwrap(
    await ctx.supabase
      .from('content_flags')
      .update({ status: 'superseded' })
      .eq('item_type', flag.item_type)
      .eq('item_id', flag.item_id)
      .eq('item_version', flag.item_version)
      .in('status', ['open', 'triaged', 'hidden_pending'])
      .neq('id', flag.id),
    'content_flags',
  );
  const today = localDateOf(ctx.now(), 'America/Sao_Paulo');
  for (const userId of affected) {
    await ctx.execute('notify.dispatch', { user_id: userId, type: 'content_fixed', data: { items: 1 } }, { singletonKey: `content_fixed:${userId}:${today}` });
  }
  await ctx.execute('xp.award', {
    user_id: flag.reporter_id,
    events: [{ event: { kind: 'error_report_accepted' }, ref_type: 'content_flag', ref_id: flag.id, source_feature: 'TRU-02', occurred_at: ctx.now().toISOString() }],
  }, { singletonKey: `xp:content_flag:${flag.id}` });
  return { status: 'applied', version: newVersion, regraded, affectedUsers: affected.size };
}

async function quizKindsOf(ctx: OperationContext, attemptIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(attemptIds, 150)) {
    const attempts = unwrapRows<{ id: string; quiz_id: string }>(await ctx.supabase.from('quiz_attempts').select('id,quiz_id').in('id', part), 'quiz_attempts');
    const quizIds = uniq(attempts.map((a) => a.quiz_id));
    const kinds = new Map(unwrapRows<{ id: string; kind: string }>(await ctx.supabase.from('quizzes').select('id,kind').in('id', quizIds), 'quizzes').map((q) => [q.id, q.kind] as const));
    for (const a of attempts) out.set(a.id, kinds.get(a.quiz_id) ?? '');
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}


export const jobs: OperationDefinition[] = [
  { name: 'flag.triage', handler: async (ctx, data) => void (await handleFlagTriage(ctx, data)) },
  { name: 'flag.apply_fix', handler: async (ctx, data) => void (await handleFlagApply(ctx, data)) },
];
