import { gradeAnswer, suggestMistakeCause } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  ActionBar,
  BottomSheet,
  Button,
  CausePicker,
  ConfidencePicker,
  ErrorState,
  FeedbackPanel,
  IconButton,
  ListItem,
  ProgressBar,
  QuestionView,
  Row,
  Screen,
  SkeletonList,
  Text,
  useOverlay,
} from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { useSession } from '../../features/auth/session';
import { formatClock } from '../../features/common/format';
import { ExplainSheet } from '../../features/learn/ExplainSheet';
import { useQuizBundle } from '../../features/practice/api';
import { usePickedCauses } from '../../features/practice/causes';
import { isAnswered, type Confidence, type GradeResult, type MistakeCause, type QuestionResponse, type QuestionRow } from '../../features/practice/types';
import { FlagSheet } from '../../features/trust/FlagSheet';
import { openTutor } from '../../features/tutor/open';
import { t } from '../../i18n';
import { useQuizRunnerStore } from '../../stores/quiz-runner';
import { space } from '../../theme';

/**
 * S-PRA-04/05/06 — question runner. Practice mode: select → (confidence) → Confirmar → feedback in
 * place. Simulado: timer, navigator, "Marcar pra revisar", no feedback until "Entregar" (PRA-03).
 * Answers are persisted on every change, so a killed app resumes where it stopped.
 */
export default function QuizRunner() {
  const { quizId, attemptId } = useLocalSearchParams<{ quizId: string; attemptId?: string }>();
  const bundle = useQuizBundle(quizId);
  const db = useDb();
  const { userId, profile } = useSession();
  const overlay = useOverlay();
  const runner = useQuizRunnerStore();
  const pickCause = usePickedCauses((s) => s.set);
  const quiz = bundle.data?.quiz;
  const questions = bundle.data?.questions ?? [];
  const exam = quiz?.mode === 'exam_conditions' || quiz?.mode === 'relaxed';
  const confidenceOn = (profile?.settings as { confidence_enabled?: boolean } | undefined)?.confidence_enabled !== false;

  const [response, setResponse] = useState<QuestionResponse | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [result, setResult] = useState<GradeResult | null>(null);
  const [cause, setCause] = useState<MistakeCause | null>(null);
  const [hints, setHints] = useState(0);
  const [suggested, setSuggested] = useState<MistakeCause | null>(null);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [navigator, setNavigator] = useState(false);
  const [flag, setFlag] = useState(false);
  const [explain, setExplain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const shownAt = useRef(Date.now());
  const submitted = useRef(false);

  // Start or resume the persisted runner for this attempt.
  useEffect(() => {
    if (!quiz || !userId) return;
    if (runner.quizId !== quiz.id) runner.start({ quizId: quiz.id, attemptId, userId, questionIds: quiz.question_ids, timeLimitS: quiz.time_limit_s });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz?.id, userId]);

  const q: QuestionRow | undefined = questions[runner.index];
  useEffect(() => {
    if (!q) return;
    const saved = runner.answers[q.id];
    setResponse((saved?.response as QuestionResponse | undefined) ?? null);
    setConfidence(saved?.confidence ?? null);
    setHints(saved?.hintsUsed ?? 0);
    setResult(null);
    setCause(null);
    shownAt.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.id]);

  // Simulado clock (pauses excluded); auto-submit at time end, also offline.
  useEffect(() => {
    if (!quiz?.time_limit_s) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quiz?.time_limit_s]);
  const remaining = quiz?.time_limit_s ? quiz.time_limit_s - runner.elapsedSeconds(now) : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !submitted.current) {
      overlay.snack(t('sim.time_up'));
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  const persist = (r: QuestionResponse | null, c: Confidence | null) => {
    if (!q) return;
    runner.answer(q.id, { response: r, confidence: c });
  };

  const confirm = () => {
    if (!q) return;
    persist(response, confidence);
    // PRA-08.3: each hint lowers the credit of a correct problem answer.
    const g = gradeAnswer(q.type as never, q.payload as never, response as never, { hintsUsed: hints }) as GradeResult;
    setResult(g);
    if (g.correct === false || (g.score != null && g.score < 1 && !g.pending)) {
      // PRA-04 §8.5: no AI call at answer time — the cause is suggested deterministically.
      const s = suggestMistakeCause({
        type: q.type as never,
        stem: q.stem,
        payload: q.payload as never,
        response: response as never,
        confidence,
        timeSeconds: (Date.now() - shownAt.current) / 1000,
        medianTimeSeconds: null,
      }) as MistakeCause;
      setSuggested(s);
      setCause(s);
      if (attemptId) pickCause(attemptId, q.id, s);
      overlay.snack({ message: t('quiz.card_toast'), actionLabel: t('quiz.card_toast_dismiss'), onAction: () => undefined, durationMs: 4000 });
    }
  };

  const goNext = () => {
    if (runner.index >= questions.length - 1) void submit();
    else runner.goTo(runner.index + 1);
  };

  const submit = async () => {
    if (submitted.current) return;
    if (exam) {
      const unanswered = questions.filter((x) => !isAnswered(x.type, runner.answers[x.id]?.response as QuestionResponse)).length;
      if ((remaining === null || remaining > 0) && (unanswered > 0 || marked.size > 0)) {
        const ok = await overlay.confirm({ title: t('sim.submit'), message: t('sim.submit_confirm', { n: unanswered, m: marked.size }), confirmLabel: t('sim.submit') });
        if (!ok) return;
      }
    }
    submitted.current = true;
    // Local score for offline results (auto-gradable types); server re-scores authoritatively.
    let correct = 0;
    for (const x of questions) {
      const g = gradeAnswer(x.type as never, x.payload as never, (runner.answers[x.id]?.response ?? null) as never) as GradeResult;
      if (g.correct) correct++;
    }
    const id = await runner.submit(db);
    router.replace({ pathname: '/practice/result/[attemptId]', params: { attemptId: id ?? attemptId ?? '', k: String(correct), n: String(questions.length), quizId } });
  };

  if (bundle.isError) return <Screen title="" immersive><ErrorState onRetry={bundle.refetch} /></Screen>;
  if (!quiz || !q) return <Screen title="" immersive><SkeletonList rows={4} height={64} /></Screen>;

  const answered = isAnswered(q.type, response);
  const needsConfidence = confidenceOn && !exam && answered && !result;
  const subjectShared = false;

  return (
    <Screen
      title={t('quiz.question_of', { i: runner.index + 1, n: questions.length })}
      immersive
      onBack={async () => {
        if (await overlay.confirm({ title: t('global.leave_confirm_title'), message: t('global.leave_confirm_body'), confirmLabel: t('global.leave'), cancelLabel: t('global.stay') })) router.back();
      }}
      actions={
        <>
          {exam ? <IconButton icon="grid-outline" label={t('sim.navigator')} onPress={() => setNavigator(true)} /> : null}
          <IconButton icon={marked.has(q.id) ? 'bookmark' : 'bookmark-outline'} label={t('quiz.mark')} onPress={() => setMarked((m) => { const n = new Set(m); if (n.has(q.id)) n.delete(q.id); else n.add(q.id); return n; })} />
        </>
      }
      context={
        <Row>
          <View style={{ flex: 1 }}>
            <ProgressBar value={(runner.index + (result ? 1 : 0)) / questions.length} />
          </View>
          {remaining !== null ? (
            <Text variant="label" tone={remaining < 60 ? 'warning' : 'secondary'} accessibilityLiveRegion="none">
              {t('sim.time_left', { time: formatClock(remaining) })}
            </Text>
          ) : null}
        </Row>
      }
      footer={
        <ActionBar>
          {exam ? (
            <Row>
              <Button style={{ flex: 1 }} variant="secondary" label={t('global.back')} disabled={runner.index === 0} onPress={() => runner.goTo(runner.index - 1)} />
              {runner.index < questions.length - 1 ? (
                <Button style={{ flex: 1 }} label={t('quiz.next')} onPress={() => (persist(response, null), runner.goTo(runner.index + 1))} />
              ) : (
                <Button style={{ flex: 1 }} label={t('sim.submit')} onPress={() => (persist(response, null), void submit())} />
              )}
            </Row>
          ) : result ? (
            <Button label={runner.index >= questions.length - 1 ? t('quiz.finish') : t('quiz.next')} onPress={goNext} />
          ) : (
            <>
              <Button label={t('quiz.confirm')} disabled={!answered || (confidenceOn && !confidence)} onPress={confirm} />
              <Button variant="text" label={t('quiz.skip')} onPress={() => (persist(null, null), goNext())} />
            </>
          )}
        </ActionBar>
      }
    >
      <QuestionView
        question={q}
        response={response}
        onChange={(r) => (setResponse(r), exam && persist(r, null))}
        revealed={!!result && !result.pending}
        hintsUsed={hints}
        // Hints are a practice aid (PRA-08.3); simulados run without them.
        onHint={exam ? undefined : () => {
          const n = hints + 1;
          setHints(n);
          runner.answer(q.id, { response, confidence, hintsUsed: n });
        }}
      />
      {needsConfidence ? (
        <View style={{ gap: space.xs }}>
          <ConfidencePicker value={confidence} onChange={setConfidence} />
          <Button compact variant="text" label="pular" onPress={() => setConfidence(2)} />
        </View>
      ) : null}
      {result ? (
        <View style={{ gap: space.md }}>
          <FeedbackPanel
            question={q}
            response={response}
            result={result}
            onAskTutor={() => openTutor({ type: 'topic', subject_id: q.subject_id, node_id: q.node_id }, { prefill: `Não entendi a questão: ${q.stem.slice(0, 300)}` })}
            onExplain={() => setExplain(true)}
            onFlag={() => setFlag(true)}
          />
          {result.correct === false && !result.pending ? (
            <CausePicker
              value={cause}
              suggested={suggested}
              onChange={(c) => {
                setCause(c);
                if (attemptId) pickCause(attemptId, q.id, c);
              }}
            />
          ) : null}
        </View>
      ) : null}
      <FlagSheet visible={flag} onClose={() => setFlag(false)} itemType="question" itemId={q.id} shared={subjectShared} />
      <ExplainSheet visible={explain} onClose={() => setExplain(false)} target={{ target_type: 'question_explanation', target_id: q.id }} subjectId={q.subject_id} />
      <BottomSheet visible={navigator} onClose={() => setNavigator(false)} title={t('sim.navigator')}>
        <ScrollView>
          {questions.map((x, i) => (
            <ListItem
              key={x.id}
              title={t('quiz.question_of', { i: i + 1, n: questions.length })}
              subtitle={[isAnswered(x.type, runner.answers[x.id]?.response as QuestionResponse) ? '✓' : '—', marked.has(x.id) ? t('quiz.mark') : null].filter(Boolean).join(' · ')}
              onPress={() => (setNavigator(false), runner.goTo(i))}
            />
          ))}
        </ScrollView>
      </BottomSheet>
    </Screen>
  );
}
