// Prova Provável jobs (PRA-09, ING-07, spec 08): pp.analyze_past_test extracts a past test and its
// teacher profile; pp.generate builds the predicted test from the blueprint; schedule.import reads a
// school calendar. Model output is validated with the prompt schemas and checked against stored pages.
import { z } from 'zod';
import { estLearnMinutes, localDateOf, wallTimeToInstant } from '@studify/shared';
import { checkPatternEvidence, pastTestExtract, PastTestExtraction, PredictedTest, predictedTestGenerate, ScheduleImport, ingestScheduleExtract, teacherProfileBuild, TeacherPatterns, type PdfSlice, type PredictedTestInput, type ScheduleAttachment } from '@studify/prompts';
import type { OperationContext, OperationDefinition } from '../framework/types.ts';
import { pagesAllowed, runPrompt, documentIdForLabel, type AiScope } from '../lib/ai-adapter.ts';
import { IN_CHUNK, JobDataError, chunk, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { downloadBase64, loadDocument, slicesFor, wholeDocumentSlice, type DocumentRow } from '../lib/documents.ts';
import { clampDifficulty, questionPayloadFor, type ExtractedQuestion } from '../lib/prova-questions.ts';
import { predictedBlueprint, teacherStatistics, teacherTopicWeights, hash32, type PastTestFact } from '../lib/prova.ts';
import { safeTimeZone } from '../lib/time.ts';

const AnalyzePayload = z.object({ document_id: z.string().min(1) });
const GeneratePayload = z.object({ exam_id: z.string().min(1), user_id: z.string().min(1) });
const SchedulePayload = z.object({ schedule_import_id: z.string().min(1) });

const normalizeTeacher = (name: string | null | undefined): string | null => (name ? name.trim().toLowerCase().replace(/\s+/g, ' ') : null);

/**
 * teacher_profiles is unique on (subject_id, coalesce(teacher_key, '')), an expression index that an
 * upsert cannot target, so reads and writes go through a plain lookup: NULL keys match with IS NULL.
 */
function teacherProfileQuery(ctx: OperationContext, subjectId: string, teacherKey: string | null, columns: string) {
  const query = ctx.supabase.from('teacher_profiles').select(columns).eq('subject_id', subjectId);
  return teacherKey === null ? query.is('teacher_key', null) : query.eq('teacher_key', teacherKey);
}

async function writeTeacherProfile(ctx: OperationContext, subjectId: string, teacherKey: string | null, values: Record<string, unknown>): Promise<void> {
  const found = unwrap(await teacherProfileQuery(ctx, subjectId, teacherKey, 'id').maybeSingle(), 'teacher_profiles') as { id: string } | null;
  if (found) {
    unwrap(await ctx.supabase.from('teacher_profiles').update(values).eq('id', found.id), 'teacher_profiles');
    return;
  }
  unwrap(await ctx.supabase.from('teacher_profiles').insert({ subject_id: subjectId, teacher_key: teacherKey, version: 1, ...values }), 'teacher_profiles');
}

export interface AnalyzeOutcome {
  status: 'ready' | 'skipped';
  questions: number;
  skipped: Record<string, number>;
  teacherTests?: number;
}

/** pp.analyze_past_test (PRA-09.2–9.4). Only past_test documents are analysed. */
export async function handleAnalyzePastTest(ctx: OperationContext, raw: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'PRA-09.2' }): Promise<AnalyzeOutcome> {
  const payload = AnalyzePayload.parse(raw);
  const doc = await loadDocument(ctx, payload.document_id);
  if (doc.kind !== 'past_test') return { status: 'skipped', questions: 0, skipped: { not_past_test: 1 } };
  const subject = unwrap(await ctx.supabase.from('subjects').select('name,content_language,owner_class_group_id,owner_profile_id').eq('id', doc.subject_id).maybeSingle(), 'subjects') as {
    name: string;
    content_language: string | null;
  } | null;
  if (!subject) throw new JobDataError('subject missing for past test', 'not_found');
  await ctx.progress({ stage: 'extract', status: 'running' });
  unwrap(await ctx.supabase.from('documents').update({ status: 'processing' }).eq('id', doc.id), 'documents');

  const nodes = unwrapRows<{ id: string; kind: string; title: string; summary: string | null }>(
    await ctx.supabase.from('knowledge_nodes').select('id,kind,title,summary').eq('subject_id', doc.subject_id).is('deleted_at', null),
    'knowledge_nodes',
  );
  const nodeIds = new Set(nodes.map((n) => n.id));
  const isPdf = doc.mime_type === 'application/pdf';
  const source = isPdf
    ? { kind: 'pdf' as const, slice: await wholeDocumentSlice(ctx, doc) }
    : { kind: 'photos' as const, images: [{ data: await downloadBase64(ctx, 'photos', doc.storage_path), mediaType: doc.mime_type === 'image/png' ? ('image/png' as const) : ('image/jpeg' as const) }] };
  const outcome = await runPrompt(ctx.ai, {
    task: pastTestExtract,
    schema: PastTestExtraction,
    input: {
      subjectName: subject.name,
      outline: nodes.map((n) => ({ key: n.id, kind: (n.kind === 'unit' || n.kind === 'concept' ? n.kind : 'topic') as 'unit' | 'topic' | 'concept', title: n.title, summary: (n.summary ?? '').slice(0, 200) })),
      source,
      teacherGuess: doc.teacher_name,
      contentLanguage: subject.content_language ?? 'pt-BR',
    },
    scope: { ...scope, userId: null, subjectId: doc.subject_id, documentId: doc.id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') {
    unwrap(await ctx.supabase.from('documents').update({ status: 'failed', error_code: outcome.result.status === 'refused' ? 'ai_refused' : 'ai_failed' }).eq('id', doc.id), 'documents');
    throw new JobDataError(`pastTest.extract ${outcome.result.status}`, 'ai_failed');
  }
  const extraction = outcome.result.data;
  const skipped: Record<string, number> = {};
  const rows: Array<Record<string, unknown>> = [];
  for (const q of extraction.questions) {
    const match = q.node_matches.filter((m) => nodeIds.has(m.node_key) && m.confidence >= 0.6).sort((a, b) => b.confidence - a.confidence)[0];
    if (!match) {
      skipped.unmatched_topic = (skipped.unmatched_topic ?? 0) + 1;
      continue;
    }
    const shaped = questionPayloadFor(q as ExtractedQuestion);
    if (!shaped.ok) {
      skipped[shaped.reason] = (skipped[shaped.reason] ?? 0) + 1;
      continue;
    }
    rows.push({
      subject_id: doc.subject_id,
      node_id: match.node_key,
      concept_ids: [],
      type: shaped.type,
      stem: q.statement_md,
      payload: shaped.payload,
      explanation: q.solution_md,
      bloom_level: q.bloom,
      difficulty: clampDifficulty(q.difficulty),
      has_math: q.statement_md.includes('$'),
      source_pages: isPdf ? [{ document_id: doc.id, page_start: q.page, page_end: q.page }] : [],
      origin: 'past_test',
      source_document_id: doc.id,
      position: q.position,
      points: q.points,
      format_features: q.format_features,
      answer_key_source: q.answer?.source ?? null,
      node_match_confidence: match.confidence,
      review_status: 'approved',
      status: 'active',
      version: 1,
      prompt_version: pastTestExtract.promptVersion,
    });
  }
  // Re-analysis replaces this document's questions (idempotent for the document).
  unwrap(await ctx.supabase.from('questions').delete().eq('source_document_id', doc.id).eq('origin', 'past_test'), 'questions delete');
  for (const part of chunk(rows, 100)) unwrap(await ctx.supabase.from('questions').insert(part), 'questions insert');

  // Teacher profile (PRA-09.4): statistics are code; the model describes patterns only with evidence.
  let teacherTests = 0;
  const teacherKey = normalizeTeacher(doc.teacher_name ?? extraction.test.teacher_guess);
  {
    const tests = unwrapRows<{ id: string; teacher_name: string | null }>(
      await ctx.supabase.from('documents').select('id,teacher_name').eq('subject_id', doc.subject_id).eq('kind', 'past_test').is('deleted_at', null),
      'documents',
    ).filter((d) => normalizeTeacher(d.teacher_name) === teacherKey);
    const questions: Array<{ id: string; source_document_id: string; type: string; stem: string; difficulty: number | null; bloom_level: string | null; points: number | null; node_id: string }> = [];
    for (const part of chunk(tests.map((t) => t.id), IN_CHUNK)) {
      questions.push(...unwrapRows(await ctx.supabase.from('questions').select('id,source_document_id,type,stem,difficulty,bloom_level,points,node_id').in('source_document_id', part).eq('origin', 'past_test'), 'questions'));
    }
    teacherTests = tests.length;
    const facts: PastTestFact[] = tests.map((t) => ({
      testId: t.id,
      totalPoints: null,
      questions: questions
        .filter((q) => q.source_document_id === t.id)
        .map((q) => ({ type: q.type, bloom: q.bloom_level ?? 'understand', difficulty: q.difficulty, points: q.points, nodeId: q.node_id })),
    }));
    const statistics = teacherStatistics(facts);
    let patterns: Array<{ text: string; evidence_question_ids: string[] }> = [];
    let styleNotes: string | null = null;
    let verbs: string[] = [];
    if (questions.length > 0) {
      const profileRun = await runPrompt(ctx.ai, {
        task: teacherProfileBuild,
        schema: TeacherPatterns,
        input: {
          teacherName: doc.teacher_name ?? extraction.test.teacher_guess ?? 'Professor(a)',
          tests: tests.map((t) => ({
            testId: t.id,
            questions: questions.filter((q) => q.source_document_id === t.id).map((q) => ({ id: q.id, type: q.type, statement: q.stem, bloom: q.bloom_level ?? 'understand', points: q.points, commandVerb: null })),
          })),
          statistics,
          contentLanguage: subject.content_language ?? 'pt-BR',
        },
        scope: { ...scope, userId: null, subjectId: doc.subject_id, feature: 'PRA-09.4' },
      });
      if (profileRun.result.status === 'ok') {
        const testOf = Object.fromEntries(questions.map((q) => [q.id, q.source_document_id]));
        const failing = new Set(checkPatternEvidence(profileRun.result.data.patterns, testOf));
        patterns = profileRun.result.data.patterns.filter((_p, i) => !failing.has(i));
        styleNotes = profileRun.result.data.style_notes;
        verbs = profileRun.result.data.typical_command_verbs;
      } else {
        ctx.log.warn({ status: profileRun.result.status }, 'pp.analyze_past_test: teacher patterns not stored');
      }
    }
    await writeTeacherProfile(ctx, doc.subject_id, teacherKey, {
      teacher_display: doc.teacher_name ?? extraction.test.teacher_guess,
      source_document_ids: tests.map((t) => t.id),
      n_tests: tests.length,
      profile: { statistics, patterns, style_notes: styleNotes, typical_command_verbs: verbs },
      confidence: tests.length >= 3 ? 'high' : tests.length >= 2 ? 'mid' : 'low',
      computed_at: ctx.now().toISOString(),
    });
  }
  unwrap(await ctx.supabase.from('documents').update({ status: 'ready', error_code: null }).eq('id', doc.id), 'documents');
  await ctx.progress({ stage: 'done', status: 'succeeded', items_total: extraction.questions.length, items_done: rows.length });
  return { status: 'ready', questions: rows.length, skipped, teacherTests };
}

export interface GenerateOutcome {
  status: 'generated' | 'skipped';
  quizId?: string;
  questions?: number;
  missingSlots?: number;
}

/** pp.generate (PRA-09.6–9.7): blueprint from teacher weights, questions from predictedTest.generate. */
export async function handleGeneratePredicted(ctx: OperationContext, raw: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'PRA-09.7' }): Promise<GenerateOutcome> {
  const payload = GeneratePayload.parse(raw);
  const exam = unwrap(
    await ctx.supabase.from('exams').select('id,goal_id,subject_id,title,local_date,teacher_name,status').eq('id', payload.exam_id).eq('user_id', payload.user_id).is('deleted_at', null).maybeSingle(),
    'exams',
  ) as { id: string; goal_id: string; subject_id: string | null; title: string; local_date: string; teacher_name: string | null; status: string } | null;
  if (!exam || exam.status !== 'scheduled' || !exam.subject_id) return { status: 'skipped' };
  const subject = unwrap(await ctx.supabase.from('subjects').select('name,content_language,is_language_subject').eq('id', exam.subject_id).maybeSingle(), 'subjects') as {
    name: string;
    content_language: string | null;
    is_language_subject: boolean;
  } | null;
  if (!subject) return { status: 'skipped' };

  const scopeNodes = unwrapRows<{ node_id: string }>(await ctx.supabase.from('exam_scope_nodes').select('node_id').eq('exam_id', exam.id), 'exam_scope_nodes').map((r) => r.node_id);
  const topics = unwrapRows<{ id: string; title: string; kind: string; subject_id: string }>(
    await ctx.supabase.from('knowledge_nodes').select('id,title,kind,subject_id').eq('subject_id', exam.subject_id).eq('kind', 'topic').is('deleted_at', null),
    'knowledge_nodes',
  );
  const scopeTopics = (scopeNodes.length ? topics.filter((t) => scopeNodes.includes(t.id)) : topics).map((t) => t.id);
  if (scopeTopics.length === 0) return { status: 'skipped' };

  const sources = unwrapRows<{ node_id: string; document_id: string; page_start: number; page_end: number }>(
    await ctx.supabase.from('node_sources').select('node_id,document_id,page_start,page_end').in('node_id', scopeTopics),
    'node_sources',
  );
  const sourcesOf = new Map<string, Array<{ kind: 'slides' | 'notes' | 'textbook' | 'other'; pages: number }>>();
  for (const s of sources) sourcesOf.set(s.node_id, [...(sourcesOf.get(s.node_id) ?? []), { kind: 'other', pages: s.page_end - s.page_start + 1 }]);
  const base = normalize(Object.fromEntries(scopeTopics.map((id) => [id, estLearnMinutes(sourcesOf.get(id) ?? [])])));

  const teacherKey = normalizeKey(exam.teacher_name);
  const profileRow = unwrap(
    await teacherProfileQuery(ctx, exam.subject_id, teacherKey, 'profile,n_tests').maybeSingle(),
    'teacher_profiles',
  ) as { profile: { statistics?: { pointsShare?: Record<string, number>; questionsPerTest?: number; typeMix?: Record<string, number>; bloomMix?: Record<string, number>; difficultyMean?: number }; patterns?: unknown } ; n_tests: number } | null;
  const stats = profileRow?.profile.statistics;
  const weights = teacherTopicWeights(scopeTopics.sort(), base, stats?.pointsShare ?? {}, profileRow?.n_tests ?? 0);

  const earlier = unwrapRows<{ id: string }>(await ctx.supabase.from('quizzes').select('id').eq('exam_id', exam.id).eq('kind', 'predicted_test'), 'quizzes');
  const regeneration = earlier.length;
  const seed = `${payload.user_id}|${exam.id}|${regeneration}`;
  const blueprint = predictedBlueprint({
    questionsPerTest: stats?.questionsPerTest && stats.questionsPerTest > 0 ? stats.questionsPerTest : 10,
    typeMix: stats?.typeMix && Object.keys(stats.typeMix).length ? stats.typeMix : { mcq_single: 0.7, short_answer: 0.3 },
    bloomMix: stats?.bloomMix && Object.keys(stats.bloomMix).length ? stats.bloomMix : { understand: 0.5, apply: 0.5 },
    difficultyMean: stats?.difficultyMean ?? 3,
    weights,
    seed,
  });
  const topicTitle = new Map(topics.map((t) => [t.id, t.title] as const));
  const examples = unwrapRows<{ type: string; stem: string }>(
    await ctx.supabase.from('questions').select('type,stem').eq('subject_id', exam.subject_id).eq('origin', 'past_test').is('deleted_at', null).limit(6),
    'questions',
  ).map((q) => ({ type: q.type, statement: q.stem.slice(0, 400) }));

  // Slices of the sampled topics: cited pages only, at most four documents.
  const docIds = uniq(sources.filter((s) => scopeTopics.includes(s.node_id)).map((s) => s.document_id)).slice(0, 4);
  const slices: PdfSlice[] = [];
  for (const docId of docIds) {
    const doc: DocumentRow = await loadDocument(ctx, docId);
    const pages = sources.filter((s) => s.document_id === docId).flatMap((s) => Array.from({ length: s.page_end - s.page_start + 1 }, (_v, i) => s.page_start + i));
    slices.push(...(await slicesFor(ctx, doc, uniq(pages).sort((a, b) => a - b))));
  }

  const input: PredictedTestInput = {
    subjectName: subject.name,
    blueprint: {
      slots: blueprint.map((s) => ({
        slotId: s.slotId,
        topicKey: s.topicKey,
        topicTitle: topicTitle.get(s.topicKey) ?? '',
        type: s.type,
        points: null,
        bloom: s.bloom,
        difficulty: s.difficulty,
        formatFeatures: [],
      })),
    },
    teacherProfile: profileRow ? { style_notes: null, patterns: profileRow.profile.patterns ?? [] } : {},
    examples,
    slices,
    contentLanguage: subject.content_language ?? 'pt-BR',
    languageSubject: subject.is_language_subject,
  };
  await ctx.progress({ stage: 'generate', status: 'running' });
  const outcome = await runPrompt(ctx.ai, {
    task: predictedTestGenerate,
    schema: PredictedTest,
    input,
    scope: { ...scope, userId: payload.user_id, subjectId: exam.subject_id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') throw new JobDataError(`predictedTest.generate ${outcome.result.status}`, 'ai_failed');

  const slotById = new Map(blueprint.map((s) => [s.slotId, s] as const));
  const questionRows: Array<Record<string, unknown>> = [];
  const generated = outcome.result.data.questions.filter((q) => slotById.has(q.slot_id));
  for (const q of generated) {
    const slot = slotById.get(q.slot_id);
    if (!slot) continue;
    const sourcePages = q.source_pages.filter((p) => pagesAllowed(outcome.documents, p.doc, p.page_start, p.page_end)).map((p) => ({
      document_id: documentIdForLabel(outcome.documents, p.doc),
      page_start: p.page_start,
      page_end: p.page_end,
    })).filter((p): p is { document_id: string; page_start: number; page_end: number } => p.document_id !== null);
    if (sourcePages.length === 0) continue;
    const shaped = questionPayloadFor({
      type: slot.type,
      statement_md: q.statement_md,
      alternatives: q.alternatives,
      answer: { value: q.answer, source: 'generated' },
      solution_md: q.solution_md,
      points: null,
    });
    if (!shaped.ok) continue;
    questionRows.push({
      subject_id: exam.subject_id,
      node_id: slot.topicKey,
      concept_ids: [],
      type: shaped.type,
      stem: q.statement_md,
      payload: shaped.payload,
      explanation: q.explanation_md,
      bloom_level: slot.bloom,
      difficulty: clampDifficulty(slot.difficulty),
      has_math: q.statement_md.includes('$'),
      source_pages: sourcePages,
      origin: 'generated',
      rationale: q.rationale,
      answer_key_source: 'generated',
      review_status: 'approved',
      status: 'active',
      version: 1,
      personal_for_user_id: payload.user_id,
      prompt_version: predictedTestGenerate.promptVersion,
    });
  }
  if (questionRows.length === 0) throw new JobDataError('predictedTest produced no valid question', 'invalid_output');
  const inserted = unwrapRows<{ id: string }>(await ctx.supabase.from('questions').insert(questionRows).select('id'), 'questions insert');
  const quiz = unwrap(
    await ctx.supabase
      .from('quizzes')
      .insert({
        owner_id: payload.user_id,
        subject_id: exam.subject_id,
        goal_id: exam.goal_id,
        exam_id: exam.id,
        kind: 'predicted_test',
        mode: 'practice',
        title: `Prova Provável — ${exam.title}`,
        question_ids: inserted.map((q) => q.id),
        scope: { exam_id: exam.id, node_ids: scopeTopics },
        config: { predicted: true, blueprint: blueprint.length, regeneration, rationale: generated.map((q) => q.rationale).slice(0, 60) },
        seed: hash32(seed),
      })
      .select('id')
      .single(),
    'quizzes insert',
  ) as { id: string } | null;
  return { status: 'generated', quizId: quiz?.id, questions: inserted.length, missingSlots: blueprint.length - generated.length };
}

function normalize(values: Record<string, number>): Record<string, number> {
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, total > 0 ? v / total : 0]));
}

function normalizeKey(name: string | null): string | null {
  return name ? name.trim().toLowerCase().replace(/\s+/g, ' ') : null;
}

export interface ScheduleOutcome {
  status: 'extracted' | 'skipped';
  exams?: number;
}

/** ING-07 schedule.import: extracts the calendar of a schedule document into schedule_imports.extracted (draft). */
export async function handleScheduleImport(ctx: OperationContext, raw: Record<string, unknown>, scope: AiScope = { userId: null, feature: 'ING-07' }): Promise<ScheduleOutcome> {
  const payload = SchedulePayload.parse(raw);
  const row = unwrap(await ctx.supabase.from('schedule_imports').select('id,user_id,document_id,status').eq('id', payload.schedule_import_id).maybeSingle(), 'schedule_imports') as {
    id: string;
    user_id: string;
    document_id: string;
    status: string;
  } | null;
  if (!row || row.status !== 'draft') return { status: 'skipped' };
  const doc = await loadDocument(ctx, row.document_id);
  const attachments: ScheduleAttachment[] =
    doc.mime_type === 'application/pdf'
      ? [{ kind: 'pdf', slice: await wholeDocumentSlice(ctx, doc) }]
      : [{ kind: 'photo', data: await downloadBase64(ctx, 'photos', doc.storage_path), mediaType: doc.mime_type === 'image/png' ? 'image/png' : 'image/jpeg' }];
  const subjects = unwrapRows<{ name: string }>(await ctx.supabase.from('subjects').select('name').eq('owner_profile_id', row.user_id).is('deleted_at', null), 'subjects').map((s) => s.name);
  const profile = unwrap(await ctx.supabase.from('profiles').select('timezone').eq('id', row.user_id).maybeSingle(), 'profiles') as { timezone: string | null } | null;
  const timeZone = safeTimeZone(profile?.timezone);
  const today = localDateOf(ctx.now(), timeZone);
  const outcome = await runPrompt(ctx.ai, {
    task: ingestScheduleExtract,
    schema: ScheduleImport,
    input: { today, attachments, knownSubjects: subjects },
    scope: { ...scope, userId: row.user_id, documentId: doc.id, feature: scope.feature },
  });
  if (outcome.result.status !== 'ok') throw new JobDataError(`ingest.scheduleExtract ${outcome.result.status}`, 'ai_failed');
  const extracted = outcome.result.data.exams.map((e) => ({
    subject_name: e.subject_name,
    title: e.label ?? e.subject_name,
    local_date: e.date,
    starts_at: e.time ? wallTimeToInstant(e.date, Number(e.time.slice(0, 2)), Number(e.time.slice(3, 5)), timeZone).toISOString() : null,
    content_items: e.content_items,
    date_ambiguous: e.date_ambiguous,
    weight: e.weight,
  }));
  unwrap(await ctx.supabase.from('schedule_imports').update({ extracted }).eq('id', row.id).eq('status', 'draft'), 'schedule_imports update');
  return { status: 'extracted', exams: extracted.length };
}

export const jobs: OperationDefinition[] = [
  { name: 'pp.analyze_past_test', handler: async (ctx, data) => void (await handleAnalyzePastTest(ctx, data)) },
  {
    name: 'pp.generate',
    handler: async (ctx, data) => {
      await handleGeneratePredicted(ctx, data);
      // The API hands in the row the app follows (prova-provavel-generate): finished here, failed by the runner.
      await ctx.progress({ stage: 'done', status: 'succeeded', progress: 1 });
    },
  },
  {
    name: 'schedule.import',
    handler: async (ctx, data) => {
      const outcome = await handleScheduleImport(ctx, data);
      // The row the app follows (schedule-import): how many tests were found, so an empty photo reads as such.
      await ctx.progress({ stage: 'done', status: 'succeeded', progress: 1, items_total: outcome.exams ?? 0, items_done: outcome.exams ?? 0 });
    },
  },
];

