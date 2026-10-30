import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, View } from 'react-native';
import type { TrailAnswerReq, TrailAnswerRes, TrailGradeRes, TrailState, TrailStep } from '@studify/shared';
import {
  ActionBar,
  BottomSheet,
  Button,
  Capi,
  GenerationStatus,
  Celebrate,
  EmptyState,
  ErrorState,
  MarkdownView,
  PageChips,
  Popover,
  ProgressBar,
  RichContent,
  RichText,
  Screen,
  TermCard,
  Text,
  useOverlay,
  type Anchor,
  type IconName,
} from '../../components';
import { isApiError } from '../../api/errors';
import { ExplainSheet } from '../../features/learn/ExplainSheet';
import { useCapi } from '../../features/motivation/capi';
import { createQuiz } from '../../features/practice/api';
import { rememberLearned } from '../../features/trail/learned';
import { openTutor } from '../../features/tutor/open';
import { useSubject } from '../../features/subjects/api';
import { answerStep, gradeStep, openTrail, prepareTrail, settleStep } from '../../features/trail/api';
import { TrailHeader } from '../../features/trail/TrailHeader';
import { TrailOptions } from '../../features/trail/TrailOptions';
import { Explanation, VerdictBar } from '../../features/trail/TrailFeedback';
import { queryClient } from '../../api/queryClient';
import { cheer, thud } from '../../lib/haptics';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
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

type TrailQuestion = Extract<TrailStep, { kind: 'question' }>;

/** Rejects the record of a question whose lesson was not recorded; the lesson's own error is already on screen. */
const LESSON_NOT_RECORDED = new Error('lesson not recorded');

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
  const [selected, setSelected] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answered | null>(null);
  const [milestone, setMilestone] = useState<Milestone | null>(null);
  const [term, setTerm] = useState<{ term: string; definition: string; anchor: Anchor | null } | null>(null);
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
      // `writing`: the next step is already being written, so the wait shows at once, not when it lands. The wait
      // itself (elapsed time, "slower than usual") is GenerationStatus's.
      const wait = () => setWaiting(true);
      if (writing) wait();
      try {
        let cur = await s;
        if (cur.preparing) {
          if (!writing) wait();
          cur = await untilReady(cur);
        }
        show(cur);
      } finally {
        setWaiting(false);
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

  /** A question: the verdict is the step's own answer, shown at once; the record and the explanation follow behind it. */
  const answerQuestion = (body: TrailAnswerReq, response: NonNullable<TrailAnswerReq['response']>, question: TrailQuestion) => {
    const correct = response === question.answer.correct_option;
    if (correct) cheer();
    else thud();
    setAnswer({ stepId: question.id, grade: { correct, correct_option: question.answer.correct_option }, settle: null });
    // The server serves a question only once the lesson before it is recorded, so the record waits for that.
    const lessonRecorded = reading.current;
    settling.current = (async () => {
      if (lessonRecorded && !(await lessonRecorded)) throw LESSON_NOT_RECORDED;
      await gradeStep(body);
      return settleStep({ trail_id: body.trail_id, step_id: question.id, time_spent_ms: body.time_spent_ms });
    })().then((res) => {
      // The next step may need content (a re-explanation after a miss): start it while the student reads.
      pending.current = res.state.preparing ? untilReady(res.state) : Promise.resolve(res.state);
      pending.current.catch(() => undefined);
      setAnswer((cur) => (cur?.stepId === question.id ? { ...cur, settle: res } : cur));
      return res;
    });
    settling.current.catch((err) => {
      if (err !== LESSON_NOT_RECORDED) fail(err);
    });
  };

  const submit = async (response: TrailAnswerReq['response']) => {
    if (!state || !step) return;
    const body = { trail_id: state.trail_id, step_id: step.id, response, time_spent_ms: since(shownAt.current) };
    if (response !== null) {
      if (step.kind === 'question') answerQuestion(body, response, step);
      return;
    }
    // One tap per lesson: the next step is already on screen while the last lesson is being recorded.
    if (reading.current) return;
    if (state.next_step) {
      readLesson(body, state.next_step);
      return;
    }
    // The step after the lesson is not written yet: recording the lesson and writing that step are one wait on the
    // "Preparando" screen, not a spinner on the button first.
    setWaiting(true);
    try {
      const res = await answerStep(body);
      // The next step may need content (a re-explanation after a miss): start it while the student reads.
      pending.current = res.state.preparing ? untilReady(res.state) : Promise.resolve(res.state);
      pending.current.catch(() => undefined);
      await next(res);
    } catch (err) {
      fail(err);
    } finally {
      setWaiting(false);
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

  // Continue: the verdict is already on screen, so the button never waits. Whatever is still on its way (the record
  // from trail-settle, the next step's content) is one wait on the "Preparando" screen.
  const advance = async () => {
    const settle = settling.current;
    if (!settle) return;
    if (!answer?.settle) setWaiting(true);
    try {
      await next(await settle);
    } catch (err) {
      // The lesson's own error is already on screen.
      if (err !== LESSON_NOT_RECORDED) fail(err);
    } finally {
      setWaiting(false);
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
  // The verdict bar's tint runs on under the footer, to the screen's edge.
  const verdictTint = answer && step && answer.stepId === step.id && !milestone && !waiting ? (answer.grade.correct ? c.successSoft : c.dangerSoft) : undefined;

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
          <Button label={t('trail.lesson_done')} onPress={() => void submit(null)} />
        </ActionBar>
      );
    }
    if (answer) return <VerdictBar correct={answer.grade.correct} letter={answer.grade.correct_option} onContinue={() => void advance()} />;
    return (
      <ActionBar>
        <Button label={t('trail.check')} disabled={!selected} disabledReason={t('trail.pick_one')} onPress={() => void submit(selected as TrailAnswerReq['response'])} />
      </ActionBar>
    );
  })();

  return (
    <Screen root immersive header={<TrailHeader state={state} onMap={() => setPlanOpen(true)} />} footer={footer} footerColor={verdictTint}>
      {!state || waiting ? (
        <Preparing first={!state} capiStage={capi.visible ? capi.stage : null} />
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
          onTerm={(name, anchor) => {
            const found = step.terms.find((x) => x.term.toLowerCase() === name.toLowerCase());
            setTerm(found ? { ...found, anchor } : null);
          }}
          onExplain={() => setExplainId(step.id)}
          onAskTutor={() => openTutor({ type: 'topic', subject_id: subjectId, node_id: chapter?.topic_id }, { prefill: step.kind === 'question' ? t('trail.tutor_prefill', { stem: step.stem.slice(0, 300) }) : undefined })}
        />
      ) : (
        <EmptyState icon="map-outline" message={t('trail.no_content')} />
      )}

      <ExplainSheet visible={!!explainId} onClose={() => setExplainId(null)} target={explainId ? { target_type: 'trail_step', target_id: explainId } : null} subjectId={subjectId} />

      <Popover visible={!!term} anchor={term?.anchor ?? null} onClose={() => setTerm(null)}>
        {term ? (
          <TermCard term={term.term} onClose={() => setTerm(null)}>
            <RichContent variant="reading" text={term.definition} />
          </TermCard>
        ) : null}
      </Popover>

      <BottomSheet visible={planOpen} onClose={() => setPlanOpen(false)} title={t('trail.plan')}>
        {state ? <PlanView state={state} /> : null}
        {bossButton}
      </BottomSheet>
    </Screen>
  );
}

function Preparing({ first, capiStage }: { first: boolean; capiStage: ReturnType<typeof useCapi>['stage'] | null }) {
  return (
    <View style={{ gap: space.lg, alignItems: 'center', paddingTop: space.xl }}>
      {capiStage ? <Capi stage={capiStage} mood="curious" size={120} /> : null}
      <View style={{ alignSelf: 'stretch' }}>
        <GenerationStatus title={first ? t('trail.preparing_first') : t('trail.preparing')} detail={t('trail.preparing_detail')} slowAfterS={12} />
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

const TAG: Record<TrailStep['purpose'], { key: string; icon: IconName; tone: 'primary' | 'lagoon' | 'lamp' }> = {
  lesson: { key: 'trail.lesson', icon: 'book-outline', tone: 'primary' },
  remedial_lesson: { key: 'trail.remedial_lesson', icon: 'refresh', tone: 'lagoon' },
  practice: { key: 'trail.practice', icon: 'help-circle-outline', tone: 'primary' },
  remedial_question: { key: 'trail.remedial_question', icon: 'refresh', tone: 'lagoon' },
  checkpoint: { key: 'trail.checkpoint', icon: 'flag-outline', tone: 'lamp' },
};

/** What kind of step this is (a small tinted tag), with the concept it teaches on its own line, never cut short. */
function StepTag({ step }: { step: TrailStep }) {
  const { colors: c } = useTheme();
  const tag = TAG[step.purpose];
  const ink = tag.tone === 'lagoon' ? c.lagoon : tag.tone === 'lamp' ? c.warning : c.primary;
  const soft = tag.tone === 'lagoon' ? `${c.lagoon}22` : tag.tone === 'lamp' ? c.warningSoft : c.primarySoft;
  const label = step.kind === 'question' && step.position ? t(tag.key, { i: step.position.index, n: step.position.total }) : t(tag.key);
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: space.xs, backgroundColor: soft, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs }}>
        <Ionicons name={tag.icon} size={16} color={ink} />
        <Text variant="label" weight="bold" style={{ color: ink }}>
          {label}
        </Text>
      </View>
      <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
        {step.concept_title}
      </Text>
    </View>
  );
}

/** The lesson's key terms as keys under the text: the same floating definition as tapping the word itself. */
function Keywords({ terms, onTerm }: { terms: string[]; onTerm: (term: string, anchor: Anchor | null) => void }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, borderRadius: radius.lg, padding: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Ionicons name="bookmark" size={16} color={c.lagoon} />
        <Text variant="label" style={{ color: c.lagoon }}>
          {t('trail.keywords')}
        </Text>
      </View>
      <Text variant="bodySmall" tone="secondary">
        {t('trail.term_hint')}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {terms.map((term) => (
          <KeywordChip key={term} term={term} onPress={(anchor) => onTerm(term, anchor)} />
        ))}
      </View>
    </View>
  );
}

function KeywordChip({ term, onPress }: { term: string; onPress: (anchor: Anchor | null) => void }) {
  const { colors: c } = useTheme();
  const ref = useRef<ComponentRef<typeof View>>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={term}
      onPress={() => (ref.current ? ref.current.measureInWindow((x, y, width, height) => onPress({ x, y, width, height })) : onPress(null))}
      style={({ pressed }) => ({
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: c.lagoon,
        backgroundColor: pressed ? `${c.lagoon}33` : `${c.lagoon}14`,
        borderRadius: radius.md,
        paddingHorizontal: space.md,
        minHeight: 40,
        justifyContent: 'center',
      })}
    >
      <Text variant="label" style={{ color: c.lagoon }}>
        {term}
      </Text>
    </Pressable>
  );
}

const readMinutes = (markdown: string) => Math.max(1, Math.round(markdown.split(/\s+/).filter(Boolean).length / 200));

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
  onTerm: (term: string, anchor: Anchor | null) => void;
  onExplain: () => void;
  onAskTutor: () => void;
}) {
  const { colors: c } = useTheme();
  const terms = step.terms.map((x) => x.term);
  const intro = step.purpose === 'checkpoint' && step.kind === 'question' && step.position?.index === 1 && checkpoint;
  return (
    <View style={{ gap: space.lg }}>
      <StepTag step={step} />
      {intro ? (
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start', backgroundColor: c.warningSoft, borderRadius: radius.md, padding: space.md }}>
          <Ionicons name="flag" size={18} color={c.warning} />
          <Text style={{ flex: 1 }}>{t('trail.checkpoint_intro', { n: checkpoint.total })}</Text>
        </View>
      ) : null}

      {step.kind === 'lesson' ? (
        <>
          <View style={{ gap: space.sm }}>
            <Text variant="display">{step.title}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
              <Ionicons name="time-outline" size={16} color={c.textSecondary} />
              <Text variant="bodySmall" tone="secondary">
                {t('trail.read_time', { n: readMinutes(step.body) })}
              </Text>
            </View>
          </View>
          <MarkdownView markdown={step.body} terms={terms} onTerm={onTerm} />
          {terms.length ? <Keywords terms={terms} onTerm={onTerm} /> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button compact variant="tonal" icon="sparkles-outline" label={t('notes.explain')} onPress={onExplain} />
            <Button compact variant="text" icon="chatbubbles-outline" label={t('trail.ask_tutor')} onPress={onAskTutor} />
          </View>
        </>
      ) : (
        <>
          <MarkdownView markdown={step.stem} terms={terms} onTerm={onTerm} />
          <TrailOptions
            options={step.options}
            selected={selected}
            onSelect={onSelect}
            reveal={answer ? { correct: answer.grade.correct_option, picked: selected, rationales: step.answer.rationales } : null}
          />
          {answer ? (
            <Explanation
              feedback={step.answer}
              correct={answer.grade.correct}
              saved={!!answer.settle?.mistake_id}
              reteach={!!answer.settle?.state.preparing && !answer.grade.correct}
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

/** "Sua trilha": the whole path as a timeline, the chapter you're on opened up to its concepts. */
function PlanView({ state }: { state: TrailState }) {
  const { colors: c } = useTheme();
  const conceptIcon = { cleared: 'checkmark-circle', shaky: 'alert-circle', current: 'radio-button-on', upcoming: 'ellipse-outline' } as const;
  const conceptColor = { cleared: c.success, shaky: c.warning, current: c.primary, upcoming: c.textSecondary };
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text variant="label" tone="secondary">
            {t('trail.overall', { pct: Math.round(state.progress * 100) })}
          </Text>
          <Text variant="label" tone="secondary">
            {t('trail.chapter_short', { i: Math.min(state.chapter_index + 1, state.chapters.length), n: state.chapters.length })}
          </Text>
        </View>
        <ProgressBar value={state.progress} height={10} color={c.success} label={t('trail.title')} />
      </View>
      {state.goal ? (
        <View style={{ gap: space.xxs, backgroundColor: c.surface1, borderRadius: radius.md, padding: space.md }}>
          <Text variant="label" tone="accent">
            {t('trail.goal')}
          </Text>
          <Text>{state.goal}</Text>
        </View>
      ) : null}
      <View>
        {state.chapters.map((ch, i) => {
          const last = i === state.chapters.length - 1;
          const done = ch.status === 'done';
          const cur = ch.status === 'current';
          const ink = done ? c.success : cur ? c.primary : c.border;
          return (
            <View key={ch.topic_id} style={{ flexDirection: 'row', gap: space.md }}>
              <View style={{ alignItems: 'center', width: 32 }}>
                <View style={{ width: 32, height: 32, borderRadius: radius.md, borderWidth: 2, borderColor: ink, backgroundColor: done || cur ? ink : c.surface1, alignItems: 'center', justifyContent: 'center' }}>
                  {done ? (
                    <Ionicons name="checkmark" size={18} color={c.onPrimary} />
                  ) : cur ? (
                    <Ionicons name="play" size={14} color={c.onPrimary} />
                  ) : (
                    <Text variant="label" tone="secondary">
                      {i + 1}
                    </Text>
                  )}
                </View>
                {!last ? <View style={{ flex: 1, width: 2, minHeight: space.md, backgroundColor: done ? c.success : c.border, marginVertical: space.xxs }} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: last ? 0 : space.md }}>
                <View style={cur ? { backgroundColor: c.primarySoft, borderRadius: radius.md, padding: space.md, gap: space.xs } : { gap: space.xxs, paddingTop: space.xs }}>
                  {cur ? (
                    <Text variant="label" tone="accent">
                      {t('trail.status_current')}
                    </Text>
                  ) : null}
                  <Text weight={cur ? 'bold' : undefined} tone={ch.status === 'upcoming' ? 'secondary' : 'primary'}>
                    {ch.title}
                  </Text>
                  {ch.why && !done ? (
                    <Text variant="bodySmall" tone="secondary">
                      {ch.why}
                    </Text>
                  ) : null}
                  {cur
                    ? ch.concepts.map((concept) => (
                        <View key={concept.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                          <Ionicons name={conceptIcon[concept.state]} size={16} color={conceptColor[concept.state]} />
                          <Text variant="bodySmall" style={{ flex: 1 }} weight={concept.state === 'current' ? 'bold' : undefined}>
                            {concept.title}
                          </Text>
                          <Text variant="bodySmall" style={{ color: conceptColor[concept.state] }}>
                            {t(`trail.concept_${concept.state}`)}
                          </Text>
                        </View>
                      ))
                    : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
