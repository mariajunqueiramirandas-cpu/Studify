// peer-question-create (SOC-07.1–07.4; class A). A member writes a question for a topic of a Turma subject. The
// text is moderated, then validated against the material (grounded, one correct answer, clear, not a duplicate).
// dry_run only returns the check with suggestions; otherwise a question with no blocking issue enters the
// pending pool (origin peer), approved later by 3 👍 or a moderator (vote_peer_question / review_peer_question).
import { getTask, type PeerQuestionValidationOutput } from '@studify/prompts';
import {
  ApiFailure,
  PEER_QUESTIONS_PER_DAY,
  PeerQuestionCreateReqSchema,
  parseQuestionPayload,
  studyDayBounds,
  studyDayOf,
  type PeerQuestionCreateReq,
  type PeerQuestionCreateRes,
  type PeerValidation,
} from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicSlices } from '../shared/topic.ts';
import { requireAllowedText } from '../shared-p4/moderation.ts';

/** Words worth searching for duplicates (websearch "or" query over the stem's longer words). */
export function duplicateQuery(stem: string): string {
  const words = [...new Set(stem.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].slice(0, 8);
  return words.join(' or ');
}

export const handler = defineFunction<PeerQuestionCreateReq>({
  name: 'peer-question-create',
  // Calls Claude outside a stream: runs as a job, the request answers 202 running (ADR 0009).
  deferred: true,
  mutating: true,
  aiCall: true,
  input: PeerQuestionCreateReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const bundle = await loadTopic(deps.db, userId, input.node_id);
    if (bundle.subject.id !== input.subject_id) throw new ApiFailure('not_found');
    if (!bundle.subject.owner_class_group_id) throw new ApiFailure('invalid_request', { message: 'Perguntas da turma são só para matérias da turma.' });

    let payload: unknown;
    try {
      payload = parseQuestionPayload(input.type, input.payload);
    } catch {
      throw new ApiFailure('invalid_request', { message: 'Confere as alternativas e a resposta certa.' });
    }

    if (!input.dry_run) {
      const { start } = studyDayBounds(studyDayOf(ctx.now));
      const today = await deps.db
        .from('questions')
        .select('id', { count: 'exact', head: true })
        .eq('author_id', userId)
        .eq('origin', 'peer')
        .gte('created_at', start.toISOString());
      if (today.error) throw today.error;
      if ((today.count ?? 0) >= PEER_QUESTIONS_PER_DAY) throw new ApiFailure('rate_limited', { message: `Você já escreveu ${PEER_QUESTIONS_PER_DAY} perguntas hoje. Amanhã tem mais!` });
    }

    await requireAllowedText(deps, userId, [input.stem, JSON.stringify(input.payload), input.explanation ?? ''].join('\n').slice(0, 4000), 'SOC-07', 'Essa pergunta não pode ir pra turma assim. Tira ofensas ou dados pessoais e tenta de novo.');

    const q = duplicateQuery(input.stem);
    let candidates: Array<{ id: string; stem: string }> = [];
    if (q) {
      const found = await deps.db
        .from('questions')
        .select('id, stem')
        .eq('node_id', input.node_id)
        .eq('status', 'active')
        .is('deleted_at', null)
        .textSearch('stem_tsv', q, { type: 'websearch', config: 'simple' })
        .limit(10);
      if (found.error) throw found.error;
      candidates = (found.data ?? []) as Array<{ id: string; stem: string }>;
    }
    const keyed = candidates.map((c, i) => ({ key: `Q${i + 1}`, id: c.id, stem: c.stem.slice(0, 400) }));

    const { slices } = await topicSlices(deps, bundle);
    const built = getTask('peer.validate').build({
      topic: { title: bundle.title, summary: bundle.summary ?? '' },
      question: { type: input.type, stem: input.stem, payload, explanation: input.explanation ?? null },
      candidates: keyed.map(({ key, stem }) => ({ key, stem })),
      slices,
      contentLanguage: bundle.contentLanguage,
    });
    const out = unwrapResult(
      await callTask(claudeDepsFor(deps), { built, taskId: 'peer.validate', ctx: budgetCtxFor(bundle.subject, userId, 'SOC-07', 'user', { nodeId: input.node_id }) }),
    ) as PeerQuestionValidationOutput;

    const labels = built.documents?.labels ?? {};
    let fix: PeerValidation['suggested_fix'] = null;
    if (out.suggested_fix) {
      try {
        const parsed = JSON.parse(out.suggested_fix.payload_json) as unknown;
        fix = { stem: out.suggested_fix.stem, payload: parseQuestionPayload(input.type, parsed) as Record<string, unknown>, explanation: out.suggested_fix.explanation };
      } catch {
        fix = null;
      }
    }
    const validation: PeerValidation = {
      grounded: out.grounded,
      evidence_pages: out.evidence.filter((e) => labels[e.doc]).map((e) => ({ document_id: labels[e.doc]!, page: e.page_start })),
      single_correct_answer: out.single_correct_answer,
      clarity_issues: out.clarity_issues,
      appropriate: out.appropriate,
      duplicate_of: out.duplicate_of ? (keyed.find((k) => k.key === out.duplicate_of)?.id ?? null) : null,
      suggested_fix: fix,
    };
    const blocking: PeerQuestionCreateRes['blocking'] = [];
    if (!validation.grounded) blocking.push('not_grounded');
    if (!validation.single_correct_answer) blocking.push('not_single_answer');
    if (!validation.appropriate) blocking.push('inappropriate');
    if (validation.duplicate_of) blocking.push('duplicate');

    if (input.dry_run || blocking.length > 0) {
      return ctx.json({ status: blocking.length ? 'needs_changes' : 'ok', question_id: null, validation, blocking } satisfies PeerQuestionCreateRes);
    }

    const id = deps.newId();
    const inserted = await deps.db.from('questions').insert({
      id,
      subject_id: bundle.subject.id,
      node_id: input.node_id,
      type: input.type,
      stem: input.stem,
      payload,
      explanation: input.explanation ?? null,
      source_pages: out.evidence.filter((e) => labels[e.doc]).map((e) => ({ document_id: labels[e.doc], page_start: e.page_start, page_end: e.page_end })),
      origin: 'peer',
      author_id: userId,
      author_anonymous: input.anonymous,
      review_status: 'pending',
      status: 'active',
      has_math: /\$/.test(input.stem),
      prompt_version: built.promptVersion,
    });
    if (inserted.error) throw inserted.error;
    return ctx.json({ status: 'pending', question_id: id, validation, blocking } satisfies PeerQuestionCreateRes, 201);
  },
});

export default handler;
