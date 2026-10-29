import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { TrailAnswerReq, TrailAnswerRes, TrailGradeRes, TrailState, TrailStep } from '@studify/shared';
import {
  ActionBar,
  BottomSheet,
  Button,
  Capi,
  Celebrate,
  EmptyState,
  ErrorState,
  IconButton,
  MarkdownView,
  Options,
  PageChips,
  ProgressBar,
  RichContent,
  RichText,
  Screen,
  Skeleton,
  Text,
  useOverlay,
} from '../../components';
import { isApiError } from '../../api/errors';
import { ExplainSheet } from '../../features/learn/ExplainSheet';
import { useCapi } from '../../features/motivation/capi';
import { createQuiz } from '../../features/practice/api';
import { rememberLearned } from '../../features/trail/learned';
import { openTutor } from '../../features/tutor/open';
import { useSubject } from '../../features/subjects/api';
import { answerStep, gradeStep, openTrail, prepareTrail, settleStep } from '../../features/trail/api';
import { queryClient } from '../../api/queryClient';
import { cheer, thud } from '../../lib/haptics';
import { t } from '../../i18n';
import { radius, shade, space, useTheme } from '../../theme';
import { messageFor } from '../../api/messages';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = (from: number) => Math.min(3_600_000, Math.max(0, Date.now() - from));

/** Asks the server for the next steps' content until the step on screen is ready (lease busy → wait, ask again). */
async function untilReady(state: TrailState): Promise<TrailState> {
  let cur = state;
  for (let attempt = 0; cur.preparing && attempt < 20; attempt++) {
    const next = await prepareTrail(cur.trail_id);
    if (next.preparing) await sleep(500);
    cur = next;
  }
  return cur;
}

type Milestone = { kind: 'chapter'; title: string; next: string | null } | { kind: 'retry'; correct: number; total: number } | { kind: 'passed'; correct: number; total: number };

/** A question after the student answered: the verdict at once, the explanation when trail-settle returns. */
type Answered = { stepId: string; grade: TrailGradeRes; settle: TrailAnswerRes | null };

/** Concepts the path counts as learned: every concept of a finished chapter, and the cleared ones of the current. */
function learnedOf(state: TrailState): string[] {
  return state.chapters.flatMap((ch) => ch.concepts.filter((c) => ch.status === 'done' || c.state === 'cleared').map((c) => c.id));
}

/**
 * S-TRL-01 Trilha (TRL-01, spec 14 §5): one step at a time — lesson, questions, feedback, chapter test, then
 * Ensine o Lucas to close the chapter, and the unit's Chefão when a unit is done.
 */
export default function TrailScreen() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const subject = useSubject(subjectId);
  const { colors: c } = useTheme();
  const capi = useCapi();
  const overlay = useOverlay();

  const [state, setState] = useState<TrailState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answered | null>(null);
  const [milestone, setMilestone] = useState<Milestone | null>(null);
  const [term, setTerm] = useState<{ term: string; definition: string } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [explainId, setExplainId] = useState<string | null>(null);
  const [bossBusy, setBossBusy] = useState(false);
  const shownAt = useRef(0);
  // Each new state bumps the version; a background prefetch that comes back later never overwrites newer state.
  const version = useRef(0);
  const pending = useRef<Promise<TrailState> | null>(null);
  // trail-settle for the question on screen; Continue waits for it.
  const settling = useRef<Promise<TrailAnswerRes> | null>(null);
  // A lesson read while its next step is already on screen: its answer is recorded behind it (resolves true when it is).
  const reading = useRef<Promise<boolean> | null>(null);

  // `restartClock` false: the step on screen has been on it since before the server answered (see readLesson).
  const show = useCallback((s: TrailState, restartClock = true) => {
    version.current += 1;
    if (restartClock) shownAt.current = Date.now();
    // Flashcards (TRL-01.15): what the path taught goes first among the new cards of the review queue.
    rememberLearned(learnedOf(s));
    if (s.chapter_done) setMilestone({ kind: 'chapter', title: s.chapter_done.title, next: s.chapter_done.next_title });
    setState(s);
  }, []);

  const fail = (err: unknown) => setError(messageFor(err));

  /** Shows `s`, first waiting for its content when the next step is still being written. */
  const land = useCallback(
    async (s: TrailState | Promise<TrailState>, writing = false) => {
      // `writing`: the next step is already being written, so the wait shows at once, not when it lands.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = () => {
        setWaiting(true);
        timer = setTimeout(() => setSlow(true), 12_000);
      };
      if (writing) wait();
      try {
        let cur = await s;
        if (cur.preparing) {
          if (!writing) wait();
          cur = await untilReady(cur);
        }
        show(cur);
      } finally {
        clearTimeout(timer);
        setWaiting(false);
        setSlow(false);
      }
    },
    [show],
  );

  // Until the first state arrives the screen shows "Montando a sua trilha…".
  const load = useCallback(
    () =>
      openTrail(subjectId)
        .then((s) => land(s))
        .then(() => queryClient.invalidateQueries({ queryKey: ['trail', subjectId] }))
        .catch(fail),
    [land, subjectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Ensine o Lucas: ask again, so a good enough lesson closes the chapter.
  const phase = state?.phase;
  useFocusEffect(
    useCallback(() => {
      if (phase === 'teach') void load();
    }, [phase, load]),
  );

  // The buffer: when the server says more can be prepared ahead, do it in the background — once per step, so a
  // lookahead that keeps failing (budget, AI down) is not retried in a loop.
  const prefetched = useRef<string | null>(null);
  useEffect(() => {
    if (!state?.prefetch || state.preparing) return;
    const key = `${state.trail_id}:${state.step?.id ?? state.chapter_index}`;
    if (prefetched.current === key) return;
    prefetched.current = key;
    const at = version.current;
    // Each call writes one lesson; keep asking while the buffer still wants more (spec 14 §8.3), at most three more.
    const fill = async (cur: TrailState): Promise<TrailState> => {
      for (let i = 0; i < 3 && cur.prefetch && !cur.preparing && version.current === at; i++) cur = await prepareTrail(cur.trail_id);
      return cur;
    };
    prepareTrail(state.trail_id)
      .then(fill)
      .then((next) => {
        if (version.current === at && !next.preparing) setState(next);
      })
      .catch(() => undefined);
  }, [state]);

  const step = state?.step ?? null;

  /** A lesson read: the step after it is on screen at once and the answer is recorded behind it (trail-answer). */
  const readLesson = (body: TrailAnswerReq, upcoming: TrailStep) => {
    // A background prefetch that lands now must not put the lesson back on screen.
    version.current += 1;
    shownAt.current = Date.now();
    setState((cur) => (cur ? { ...cur, step: upcoming, next_step: null, prefetch: false } : cur));
    setSelected(null);
    reading.current = answerStep(body)
      .then((res) => (res.state.preparing ? land(res.state) : show(res.state, res.state.step?.id !== upcoming.id)))
      .then(
        () => true,
        (err) => {
          fail(err);
          return false;
        },
      )
      .finally(() => {
        reading.current = null;
      });
  };

  const submit = async (response: TrailAnswerReq['response']) => {
    if (!state || !step) return;
    const body = { trail_id: state.trail_id, step_id: step.id, response, time_spent_ms: since(shownAt.current) };
    if (response === null) {
      // One tap per lesson: the next step is already on screen while the last lesson is being recorded.
      if (reading.current) return;
      if (state.next_step) {
        readLesson(body, state.next_step);
        return;
      }
    }
    setBusy(true);
    try {
      if (response === null) {
        const res = await answerStep(body);
        // The next step may need content (a re-explanation after a miss): start it while the student reads.
        pending.current = res.state.preparing ? untilReady(res.state) : Promise.resolve(res.state);
        pending.current.catch(() => undefined);
        await next(res);
        return;
      }
      // The server serves a question only once the lesson before it is recorded, so the verdict waits for that.
      if (reading.current && !(await reading.current)) return;
      // The verdict shows at once; the explanation, the Caderno and the next step follow in the background.
      const grade = await gradeStep(body);
      if (grade.correct) cheer();
      else thud();
      setAnswer({ stepId: step.id, grade, settle: null });
      settling.current = settleStep({ trail_id: state.trail_id, step_id: step.id, time_spent_ms: body.time_spent_ms }).then((res) => {
        // The next step may need content (a re-explanation after a miss): start it while the student reads.
        pending.current = res.state.preparing ? untilReady(res.state) : Promise.resolve(res.state);
        pending.current.catch(() => undefined);
        setAnswer((cur) => (cur?.stepId === step.id ? { ...cur, settle: res } : cur));
        return res;
      });
      settling.current.catch(fail);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const next = async (res: TrailAnswerRes) => {
    if (res.checkpoint_result) setMilestone({ kind: res.checkpoint_result.passed ? 'passed' : 'retry', correct: res.checkpoint_result.correct, total: res.checkpoint_result.total });
    setAnswer(null);
    setSelected(null);
    try {
      await land(pending.current ?? res.state, res.state.preparing);
    } catch (err) {
      fail(err);
    } finally {
      pending.current = null;
      settling.current = null;
    }
    void queryClient.invalidateQueries({ queryKey: ['trail', subjectId] });
  };

  // Continue: the verdict is already on screen; move on once trail-settle has produced the next step.
  const advance = async () => {
    if (!settling.current) return;
    try {
      await next(await settling.current);
    } catch (err) {
      fail(err);
    }
  };

  const teachLucas = () => {
    if (state?.teach) router.push({ pathname: '/lucas/[nodeId]', params: { nodeId: state.teach.topic_id, subjectId } });
  };

  const fightBoss = async () => {
    if (!state?.boss) return;
    setBossBusy(true);
    try {
      const res = await createQuiz({ kind: 'boss', scope: { subject_id: subjectId, unit_node_id: state.boss.unit_id }, count: 10, mode: 'practice' });
      router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch (err) {
      // The path itself is fine; only the Chefão could not start.
      overlay.snack(isApiError(err) ? err.message : t('error.generation'));
    } finally {
      setBossBusy(false);
    }
  };

  const bossButton = state?.boss ? <Button variant="secondary" icon="skull-outline" label={t('trail.boss_fight', { unit: state.boss.title })} loading={bossBusy} onPress={() => void fightBoss()} /> : null;

  if (error) {
    return (
      <Screen title="" immersive>
        <ErrorState message={error} onRetry={() => (setError(null), void load())} />
      </Screen>
    );
  }

  const chapter = state?.chapters[state.chapter_index];
  const header = state ? (
    <View style={{ paddingHorizontal: space.gutter, gap: space.xs, paddingBottom: space.sm }}>
      <ProgressBar value={state.progress} height={10} label={t('trail.title')} />
      {chapter && state.status !== 'completed' ? (
        <Text variant="label" tone="secondary" numberOfLines={1}>
          {t('trail.chapter_label', { i: state.chapter_index + 1, n: state.chapters.length })} · {chapter.title}
        </Text>
      ) : null}
    </View>
  ) : null;

  const footer = (() => {
    if (!state || waiting || milestone) {
      return milestone ? (
        <ActionBar>
          <Button label={t('trail.continue')} onPress={() => setMilestone(null)} />
          {milestone.kind === 'chapter' ? bossButton : null}
          {milestone.kind === 'chapter' ? <Button variant="text" icon="flash-outline" label={t('trail.review_cards')} onPress={() => router.push({ pathname: '/review', params: { subjectId } })} /> : null}
        </ActionBar>
      ) : null;
    }
    if (state.status === 'completed') {
      return (
        <ActionBar>
          <Button label={t('trail.done_review')} icon="flash-outline" onPress={() => router.replace({ pathname: '/review', params: { subjectId } })} />
          {bossButton}
        </ActionBar>
      );
    }
    if (state.phase === 'teach') {
      return (
        <ActionBar>
          <Button label={t('trail.teach_start')} icon="school-outline" onPress={teachLucas} />
        </ActionBar>
      );
    }
    if (!step) return null;
    if (step.kind === 'lesson') {
      return (
        <ActionBar>
          <Button label={t('trail.lesson_done')} loading={busy} onPress={() => void submit(null)} />
        </ActionBar>
      );
    }
    if (answer) {
      return (
        <ActionBar>
          <Button label={t('trail.continue')} loading={!answer.settle} onPress={() => void advance()} />
        </ActionBar>
      );
    }
    return (
      <ActionBar>
        <Button label={t('trail.check')} disabled={!selected} disabledReason={t('trail.pick_one')} loading={busy} onPress={() => void submit(selected as TrailAnswerReq['response'])} />
      </ActionBar>
    );
  })();

  return (
    <Screen
      title=""
      immersive
      header={header}
      actions={state ? <IconButton icon="map-outline" label={t('trail.plan_open')} onPress={() => setPlanOpen(true)} /> : null}
      footer={footer}
    >
      {!state || waiting ? (
        <Preparing first={!state} slow={slow} capiStage={capi.visible ? capi.stage : null} />
      ) : milestone ? (
        <MilestoneView milestone={milestone} capiStage={capi.visible ? capi.stage : null} />
      ) : state.status === 'completed' ? (
        <View style={{ gap: space.lg, alignItems: 'center', paddingTop: space.xl }}>
          {capi.visible ? <Capi stage={capi.stage} mood="celebrating" accessories={capi.accessories} size={140} /> : null}
          <Celebrate text={t('trail.done_title')} />
          <Text align="center" tone="secondary">
            {t('trail.done_body', { subject: subject.data?.name ?? '' })}
          </Text>
        </View>
      ) : state.phase === 'teach' && state.teach ? (
        <TeachView teach={state.teach} capiStage={capi.visible ? capi.stage : null} />
      ) : step ? (
        <StepView
          key={step.id}
          step={step}
          subjectId={subjectId}
          checkpoint={state.checkpoint}
          selected={selected}
          onSelect={setSelected}
          answer={answer?.stepId === step.id ? answer : null}
          onTerm={(name) => setTerm(step.terms.find((x) => x.term.toLowerCase() === name.toLowerCase()) ?? null)}
          onExplain={() => setExplainId(step.id)}
          onAskTutor={() => openTutor({ type: 'topic', subject_id: subjectId, node_id: chapter?.topic_id }, { prefill: step.kind === 'question' ? t('trail.tutor_prefill', { stem: step.stem.slice(0, 300) }) : undefined })}
        />
      ) : (
        <EmptyState icon="map-outline" message={t('trail.no_content')} />
      )}

      <ExplainSheet visible={!!explainId} onClose={() => setExplainId(null)} target={explainId ? { target_type: 'trail_step', target_id: explainId } : null} subjectId={subjectId} />

      <BottomSheet visible={!!term} onClose={() => setTerm(null)} title={term?.term}>
        {term ? <RichContent variant="reading" text={term.definition} /> : null}
      </BottomSheet>

      <BottomSheet visible={planOpen} onClose={() => setPlanOpen(false)} title={t('trail.plan')}>
        {state?.goal ? (
          <View style={{ gap: space.xxs, marginBottom: space.sm }}>
            <Text variant="label" tone="accent">
              {t('trail.goal')}
            </Text>
            <Text>{state.goal}</Text>
          </View>
        ) : null}
        {state?.chapters.map((ch, i) => (
          <View key={ch.topic_id} style={{ flexDirection: 'row', gap: space.md, paddingVertical: space.sm }}>
            <Ionicons
              name={ch.status === 'done' ? 'checkmark-circle' : ch.status === 'current' ? 'play-circle' : 'ellipse-outline'}
              size={26}
              color={ch.status === 'done' ? c.success : ch.status === 'current' ? c.primary : c.textSecondary}
            />
            <View style={{ flex: 1, gap: space.xxs }}>
              <Text weight={ch.status === 'current' ? 'bold' : undefined}>{`${i + 1}. ${ch.title}`}</Text>
              {ch.why && ch.status !== 'done' ? (
                <Text variant="bodySmall" tone="secondary">
                  {ch.why}
                </Text>
              ) : null}
              {ch.status === 'current'
                ? ch.concepts.map((concept) => (
                    <Text key={concept.id} variant="bodySmall" tone={concept.state === 'current' ? 'accent' : 'secondary'}>
                      {concept.state === 'cleared' ? '✓' : concept.state === 'shaky' ? '•' : concept.state === 'current' ? '▶' : '○'} {concept.title} · {t(`trail.concept_${concept.state}`)}
                    </Text>
                  ))
                : null}
            </View>
          </View>
        ))}
        {bossButton}
      </BottomSheet>
    </Screen>
  );
}

function Preparing({ first, slow, capiStage }: { first: boolean; slow: boolean; capiStage: ReturnType<typeof useCapi>['stage'] | null }) {
  return (
    <View style={{ gap: space.lg, alignItems: 'center', paddingTop: space.xl }} accessibilityLiveRegion="polite">
      {capiStage ? <Capi stage={capiStage} mood="curious" size={120} /> : null}
      <Text variant="heading" align="center">
        {first ? t('trail.preparing_first') : t('trail.preparing')}
      </Text>
      {slow ? (
        <Text tone="secondary" align="center">
          {t('trail.preparing_slow')}
        </Text>
      ) : null}
      <View style={{ alignSelf: 'stretch', gap: space.sm }}>
        <Skeleton height={22} width="70%" />
        <Skeleton height={16} />
        <Skeleton height={16} />
        <Skeleton height={16} width="85%" />
      </View>
    </View>
  );
}

function MilestoneView({ milestone, capiStage }: { milestone: Milestone; capiStage: ReturnType<typeof useCapi>['stage'] | null }) {
  const won = milestone.kind !== 'retry';
  return (
    <View style={{ gap: space.lg, alignItems: 'center', paddingTop: space.xl }}>
      {capiStage ? <Capi stage={capiStage} mood={won ? 'celebrating' : 'focused'} size={140} /> : null}
      {milestone.kind === 'chapter' ? (
        <>
          <Celebrate text={t('trail.chapter_done', { title: milestone.title })} />
          {milestone.next ? (
            <Text tone="secondary" align="center">
              {t('trail.chapter_next', { title: milestone.next })}
            </Text>
          ) : null}
        </>
      ) : (
        <RichText variant="heading" align="center">
          {milestone.kind === 'retry' ? t('trail.checkpoint_failed', { k: milestone.correct, n: milestone.total }) : t('trail.checkpoint_passed', { k: milestone.correct, n: milestone.total })}
        </RichText>
      )}
    </View>
  );
}

/** The last step of a chapter (TRL-01.12): teach the topic to Lucas, scored like Ensine o Lucas anywhere else. */
function TeachView({ teach, capiStage }: { teach: NonNullable<TrailState['teach']>; capiStage: ReturnType<typeof useCapi>['stage'] | null }) {
  return (
    <View style={{ gap: space.lg, alignItems: 'center', paddingTop: space.lg }}>
      {capiStage ? <Capi stage={capiStage} mood="focused" size={120} /> : null}
      <Text variant="label" weight="bold" tone="accent">
        {t('trail.teach_label')}
      </Text>
      <Text variant="display" align="center">
        {t('trail.teach_title', { title: teach.title })}
      </Text>
      <Text tone="secondary" align="center">
        {t('trail.teach_body', { score: teach.pass_score })}
      </Text>
      {teach.best_score !== null ? (
        <RichText align="center">{t('trail.teach_best', { best: teach.best_score, score: teach.pass_score })}</RichText>
      ) : null}
    </View>
  );
}

const LABEL: Record<TrailStep['purpose'], string> = {
  lesson: 'trail.lesson',
  remedial_lesson: 'trail.remedial_lesson',
  practice: 'trail.practice',
  remedial_question: 'trail.remedial_question',
  checkpoint: 'trail.checkpoint',
};

function StepView({
  step,
  subjectId,
  checkpoint,
  selected,
  onSelect,
  answer,
  onTerm,
  onExplain,
  onAskTutor,
}: {
  step: TrailStep;
  subjectId: string;
  checkpoint: TrailState['checkpoint'];
  selected: string | null;
  onSelect: (id: string) => void;
  answer: Answered | null;
  onTerm: (term: string) => void;
  onExplain: () => void;
  onAskTutor: () => void;
}) {
  const { colors: c } = useTheme();
  const terms = step.terms.map((x) => x.term);
  const label = step.kind === 'question' && step.position ? t(LABEL[step.purpose], { i: step.position.index, n: step.position.total }) : t(LABEL[step.purpose]);
  const intro = step.purpose === 'checkpoint' && step.kind === 'question' && step.position?.index === 1 && checkpoint;
  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="label" weight="bold" tone="accent">
          {label}
        </Text>
        <Text variant="label" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          · {step.concept_title}
        </Text>
      </View>
      {intro ? <Text tone="secondary">{t('trail.checkpoint_intro', { n: checkpoint.total })}</Text> : null}

      {step.kind === 'lesson' ? (
        <>
          <Text variant="display">{step.title}</Text>
          <MarkdownView markdown={step.body} terms={terms} onTerm={onTerm} />
          {terms.length ? (
            <Text variant="bodySmall" tone="secondary">
              {t('trail.term_hint')}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button compact variant="tonal" icon="sparkles-outline" label={t('notes.explain')} onPress={onExplain} />
            <Button compact variant="text" icon="chatbubbles-outline" label={t('trail.ask_tutor')} onPress={onAskTutor} />
          </View>
        </>
      ) : (
        <>
          <MarkdownView markdown={step.stem} terms={terms} onTerm={onTerm} />
          <Options
            options={step.options.map((o) => ({ id: o.id, text: o.text }))}
            selected={selected ? [selected] : []}
            correct={answer ? [answer.grade.correct_option] : undefined}
            disabled={!!answer}
            onSelect={onSelect}
          />
          {answer ? (
            <Feedback
              answer={answer}
              picked={selected}
              borderColor={answer.grade.correct ? c.success : c.danger}
              onExplain={onExplain}
              onAskTutor={onAskTutor}
            />
          ) : null}
        </>
      )}
      <PageChips sources={step.source_pages} subjectId={subjectId} />
    </View>
  );
}

function Feedback({
  answer,
  picked,
  borderColor,
  onExplain,
  onAskTutor,
}: {
  answer: Answered;
  picked: string | null;
  borderColor: string;
  onExplain: () => void;
  onAskTutor: () => void;
}) {
  const { colors: c } = useTheme();
  const { grade, settle } = answer;
  const feedback = settle?.feedback ?? null;
  const reteach = !!settle?.state.preparing && !grade.correct;
  const saved = !!settle?.mistake_id;
  const pickedRow = feedback?.rationales.find((r) => r.id === picked);
  const right = feedback?.rationales.find((r) => r.id === grade.correct_option);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ borderWidth: 2, borderBottomWidth: 5, borderColor, borderBottomColor: shade(borderColor, 0.25), borderRadius: radius.xl, padding: space.lg, gap: space.md, backgroundColor: c.surface1 }}
    >
      <RichText variant="heading" style={{ color: borderColor }}>
        {grade.correct ? t('trail.correct') : t('trail.wrong', { letter: grade.correct_option })}
      </RichText>
      {feedback && !grade.correct && pickedRow ? (
        <View style={{ gap: space.xxs }}>
          <Text variant="label">{t('trail.why_wrong', { letter: pickedRow.id })}</Text>
          <RichContent variant="reading" text={pickedRow.rationale} />
        </View>
      ) : null}
      {feedback && right ? (
        <View style={{ gap: space.xxs }}>
          <Text variant="label">{t('trail.why_right', { letter: right.id })}</Text>
          <RichContent variant="reading" text={right.rationale} />
        </View>
      ) : null}
      {feedback ? (
        <RichContent variant="reading" text={feedback.explanation} />
      ) : (
        <Text tone="secondary">{t('trail.explanation_loading')}</Text>
      )}
      {feedback?.tip ? (
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', backgroundColor: c.infoSoft, borderRadius: radius.md, padding: space.md }}>
          <Ionicons name="bulb-outline" size={20} color={c.info} />
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="label" style={{ color: c.info }}>
              {t('trail.tip')}
            </Text>
            <RichContent text={feedback.tip} />
          </View>
        </View>
      ) : null}
      {reteach ? (
        <Text variant="bodySmall" tone="secondary">
          {t('trail.reteach_soon')}
        </Text>
      ) : null}
      {saved ? (
        <Text variant="bodySmall" tone="secondary">
          {t('trail.saved_to_caderno')}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {!grade.correct ? <Button compact variant="tonal" icon="chatbubbles-outline" label={t('quiz.dont_understand')} onPress={onAskTutor} /> : null}
        <Button compact variant="text" icon="sparkles-outline" label={t('notes.explain')} onPress={onExplain} />
      </View>
    </View>
  );
}
