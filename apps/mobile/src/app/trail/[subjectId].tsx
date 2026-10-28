import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { TrailAnswerReq, TrailAnswerRes, TrailState, TrailStep } from '@studify/shared';
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
} from '../../components';
import { isApiError } from '../../api/errors';
import { useCapi } from '../../features/motivation/capi';
import { useSubject } from '../../features/subjects/api';
import { answerStep, openTrail, prepareTrail } from '../../features/trail/api';
import { queryClient } from '../../api/queryClient';
import { cheer, thud } from '../../lib/haptics';
import { t } from '../../i18n';
import { radius, shade, space, useTheme } from '../../theme';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = (from: number) => Math.min(3_600_000, Math.max(0, Date.now() - from));

/** Asks the server for the next steps' content until the step on screen is ready (lease busy → wait, ask again). */
async function untilReady(state: TrailState): Promise<TrailState> {
  let cur = state;
  for (let attempt = 0; cur.preparing && attempt < 20; attempt++) {
    const next = await prepareTrail(cur.trail_id);
    if (next.preparing) await sleep(1500);
    cur = next;
  }
  return cur;
}

type Milestone = { kind: 'chapter'; title: string; next: string | null } | { kind: 'retry'; correct: number; total: number } | { kind: 'passed'; correct: number; total: number };

/** S-TRL-01 Trilha (TRL-01, spec 14 §5): one step at a time — lesson, questions, feedback, chapter test. */
export default function TrailScreen() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const subject = useSubject(subjectId);
  const { colors: c } = useTheme();
  const capi = useCapi();

  const [state, setState] = useState<TrailState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ stepId: string; res: TrailAnswerRes } | null>(null);
  const [milestone, setMilestone] = useState<Milestone | null>(null);
  const [term, setTerm] = useState<{ term: string; definition: string } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const shownAt = useRef(0);
  // Each new state bumps the version; a background prefetch that comes back later never overwrites newer state.
  const version = useRef(0);
  const pending = useRef<Promise<TrailState> | null>(null);

  const show = useCallback((s: TrailState) => {
    version.current += 1;
    shownAt.current = Date.now();
    setState(s);
  }, []);

  const fail = (err: unknown) => setError(isApiError(err) ? err.message : t('error.generic'));

  /** Shows `s`, first waiting for its content when the next step is still being written. */
  const land = useCallback(
    async (s: TrailState | Promise<TrailState>) => {
      let cur = await s;
      if (cur.preparing) {
        setWaiting(true);
        const timer = setTimeout(() => setSlow(true), 12_000);
        try {
          cur = await untilReady(cur);
        } finally {
          clearTimeout(timer);
          setWaiting(false);
          setSlow(false);
        }
      }
      show(cur);
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

  // The buffer: when the server says more can be prepared ahead, do it in the background — once per step, so a
  // lookahead that keeps failing (budget, AI down) is not retried in a loop.
  const prefetched = useRef<string | null>(null);
  useEffect(() => {
    if (!state?.prefetch || state.preparing) return;
    const key = `${state.trail_id}:${state.step?.id ?? state.chapter_index}`;
    if (prefetched.current === key) return;
    prefetched.current = key;
    const at = version.current;
    prepareTrail(state.trail_id)
      .then((next) => {
        if (version.current === at && !next.preparing) setState(next);
      })
      .catch(() => undefined);
  }, [state]);

  const step = state?.step ?? null;

  const submit = async (response: TrailAnswerReq['response']) => {
    if (!state || !step) return;
    setBusy(true);
    try {
      const res = await answerStep({ trail_id: state.trail_id, step_id: step.id, response, time_spent_ms: since(shownAt.current) });
      // The next step may need content (a re-explanation after a miss): start it while the student reads.
      pending.current = res.state.preparing ? untilReady(res.state) : Promise.resolve(res.state);
      pending.current.catch(() => undefined);
      if (res.feedback) {
        if (res.feedback.correct) cheer();
        else thud();
        setAnswer({ stepId: step.id, res });
      } else {
        await next(res);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const next = async (res: TrailAnswerRes) => {
    if (res.chapter_done) setMilestone({ kind: 'chapter', title: res.chapter_done.title, next: res.chapter_done.next_title });
    else if (res.checkpoint_result && !res.checkpoint_result.passed) setMilestone({ kind: 'retry', correct: res.checkpoint_result.correct, total: res.checkpoint_result.total });
    setAnswer(null);
    setSelected(null);
    try {
      await land(pending.current ?? res.state);
    } catch (err) {
      fail(err);
    } finally {
      pending.current = null;
    }
    void queryClient.invalidateQueries({ queryKey: ['trail', subjectId] });
  };

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
        </ActionBar>
      ) : null;
    }
    if (state.status === 'completed') {
      return (
        <ActionBar>
          <Button label={t('trail.done_review')} icon="flash-outline" onPress={() => router.replace({ pathname: '/review', params: { subjectId } })} />
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
          <Button label={t('trail.continue')} onPress={() => void next(answer.res)} />
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
      ) : step ? (
        <StepView
          key={step.id}
          step={step}
          subjectId={subjectId}
          checkpoint={state.checkpoint}
          selected={selected}
          onSelect={setSelected}
          answer={answer?.stepId === step.id ? answer.res : null}
          onTerm={(name) => setTerm(step.terms.find((x) => x.term.toLowerCase() === name.toLowerCase()) ?? null)}
        />
      ) : (
        <EmptyState icon="map-outline" message={t('trail.no_content')} />
      )}

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
}: {
  step: TrailStep;
  subjectId: string;
  checkpoint: TrailState['checkpoint'];
  selected: string | null;
  onSelect: (id: string) => void;
  answer: TrailAnswerRes | null;
  onTerm: (term: string) => void;
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
        </>
      ) : (
        <>
          <MarkdownView markdown={step.stem} terms={terms} onTerm={onTerm} />
          <Options
            options={step.options.map((o) => ({ id: o.id, text: o.text }))}
            selected={selected ? [selected] : []}
            correct={answer?.feedback ? [answer.feedback.correct_option] : undefined}
            disabled={!!answer}
            onSelect={onSelect}
          />
          {answer?.feedback ? <Feedback feedback={answer.feedback} picked={selected} reteach={answer.state.preparing && !answer.feedback.correct} borderColor={answer.feedback.correct ? c.success : c.danger} /> : null}
        </>
      )}
      <PageChips sources={step.source_pages} subjectId={subjectId} />
    </View>
  );
}

function Feedback({ feedback, picked, reteach, borderColor }: { feedback: NonNullable<TrailAnswerRes['feedback']>; picked: string | null; reteach: boolean; borderColor: string }) {
  const { colors: c } = useTheme();
  const pickedRow = feedback.rationales.find((r) => r.id === picked);
  const right = feedback.rationales.find((r) => r.id === feedback.correct_option);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ borderWidth: 2, borderBottomWidth: 5, borderColor, borderBottomColor: shade(borderColor, 0.25), borderRadius: radius.xl, padding: space.lg, gap: space.md, backgroundColor: c.surface1 }}
    >
      <RichText variant="heading" style={{ color: borderColor }}>
        {feedback.correct ? t('trail.correct') : t('trail.wrong', { letter: feedback.correct_option })}
      </RichText>
      {!feedback.correct && pickedRow ? (
        <View style={{ gap: space.xxs }}>
          <Text variant="label">{t('trail.why_wrong', { letter: pickedRow.id })}</Text>
          <RichContent variant="reading" text={pickedRow.rationale} />
        </View>
      ) : null}
      {right ? (
        <View style={{ gap: space.xxs }}>
          <Text variant="label">{t('trail.why_right', { letter: right.id })}</Text>
          <RichContent variant="reading" text={right.rationale} />
        </View>
      ) : null}
      <RichContent variant="reading" text={feedback.explanation} />
      {feedback.tip ? (
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
    </View>
  );
}
