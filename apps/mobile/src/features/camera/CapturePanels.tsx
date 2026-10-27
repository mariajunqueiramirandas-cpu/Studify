// Result panels of a capture (spec 11 §5): the streamed explanation (CAM-01), the hint ladder (CAM-02), adding the
// photos to a subject (CAM-01.5–01.7) and the transcription review before grading (CAM-03.3–03.5).
import { HEAVY_EDIT_RATIO, editRatio, parseTranscriptionMarkers, type CaptureActRes, type SchoolEssayFeedback } from '@studify/shared';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { AiBadge, Banner, Button, Card, Chip, ChipGroup, ListItem, PageChips, RichContent, Row, Skeleton, SubjectBadge, Text, TextField, useOnline, useOverlay } from '../../components';
import type { StreamHandle } from '../../api/functions';
import { t, options } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
import { useSession } from '../auth/session';
import { createUserCard, type Citation } from '../learn/api';
import { createQuiz } from '../practice/api';
import { useSubjects } from '../subjects/api';
import { openTutor } from '../tutor/open';
import { MicButton } from '../voice/VoiceButtons';
import { appendTranscript } from '../voice/speech-text';
import { captureAct, gradeEssay, streamCaptureExplain, streamCaptureSolution, type CaptureRow, type SolveRes } from './api';

function errorMessage(code: string | undefined): string {
  if (code === 'budget_exhausted' || code === 'rate_limited') return t('budget.user_daily');
  if (code === 'offline') return t('cam.offline');
  return t('error.generation');
}

/** "Biologia › Genética › 1ª Lei de Mendel", or the not-in-material label (CAM-01.3, CAM-02.3). */
export function MatchLine({ capture }: { capture: CaptureRow }) {
  if (!capture.match) return <Banner kind="neutral" icon="information-circle-outline" message={t('cam.not_in_material')} />;
  return <Chip icon="git-branch-outline" label={capture.match.label} onPress={() => router.push({ pathname: '/subjects/[subjectId]/topic/[nodeId]', params: { subjectId: capture.match!.subject_id, nodeId: capture.match!.node_ids[0]! } })} />;
}

/** What to do next with a capture (cam.after): practice similar, save the question, cards, ask more. */
function AfterActions({ capture, text, citations, canSaveQuestion }: { capture: CaptureRow; text: string; citations: Citation[]; canSaveQuestion: boolean }) {
  const overlay = useOverlay();
  const { userId } = useSession();
  const labels = options('cam.after');
  const nodeId = capture.match?.node_ids[0] ?? capture.node_id;
  const subjectId = capture.match?.subject_id ?? capture.subject_id;
  const [savedQuestion, setSavedQuestion] = useState(!!capture.question_id);
  return (
    <ChipGroup>
      {nodeId && subjectId ? (
        <Chip
          icon="help-circle-outline"
          label={labels[0] ?? 'Praticar parecidas'}
          onPress={async () => {
            try {
              const res = await createQuiz({ kind: 'practice', scope: { subject_id: subjectId, node_ids: [nodeId] }, count: 5, mode: 'practice' });
              router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
            } catch {
              overlay.snack(t('error.generation'));
            }
          }}
        />
      ) : null}
      {canSaveQuestion && nodeId ? (
        <Chip
          icon={savedQuestion ? 'bookmark' : 'bookmark-outline'}
          label={savedQuestion ? t('cam.question_saved') : (labels[1] ?? 'Salvar questão')}
          disabled={savedQuestion}
          onPress={async () => {
            try {
              await captureAct({ capture_id: capture.id, intent: 'save_question' });
              setSavedQuestion(true);
              overlay.snack(t('cam.question_saved'));
            } catch (e) {
              overlay.snack(errorMessage((e as { code?: string }).code));
            }
          }}
        />
      ) : null}
      {nodeId && subjectId && text ? (
        <Chip
          icon="albums-outline"
          label={labels[2] ?? 'Criar cartões disso'}
          onPress={async () => {
            await createUserCard(userId!, { subjectId, nodeId, type: 'basic', front: (capture.transcription ?? '').slice(0, 300), back: text.slice(0, 800), sourcePages: citations, origin: 'user', shared: false }).catch(() => undefined);
            overlay.snack(t('tutor.card_created'));
          }}
        />
      ) : null}
      <Chip icon="chatbubbles-outline" label={labels[3] ?? 'Perguntar mais'} onPress={() => openTutor({ type: 'capture', capture_id: capture.id, subject_id: subjectId ?? undefined, node_id: nodeId ?? undefined })} />
    </ChipGroup>
  );
}

// ---------------------------------------------------------------- CAM-01 explain

export function ExplainPanel({ capture }: { capture: CaptureRow }) {
  const [text, setText] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [state, setState] = useState<'streaming' | 'done' | 'error'>('streaming');
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const handle = useRef<StreamHandle | null>(null);

  const open = (focusText: string | null) => {
    handle.current = streamCaptureExplain(capture.id, focusText, {
      onDelta: (d) => setText((x) => x + d),
      onCitation: (c) => setCitations((x) => [...x, c]),
      onDone: (d) => setState(d.stop_reason === 'refusal' ? 'error' : 'done'),
      onError: (e) => {
        setState('error');
        setError(errorMessage(e.code));
      },
    });
    handle.current.done.catch((e: { code?: string }) => {
      if (e.code === 'cancelled') return;
      setState('error');
      setError(errorMessage(e.code));
    });
  };
  const run = (focusText: string | null) => {
    handle.current?.cancel();
    setText('');
    setCitations([]);
    setState('streaming');
    setError(null);
    open(focusText);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (open(null), () => handle.current?.cancel()), [capture.id]);

  const paragraphs = (capture.transcription ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <View style={{ gap: space.md }}>
      <MatchLine capture={capture} />
      {paragraphs.length > 1 ? (
        <Card tone="outline">
          <Text variant="label">{t('cam.explain_only')}</Text>
          <ChipGroup>
            {paragraphs.slice(0, 8).map((p, i) => (
              <Chip key={i} label={p.length > 40 ? `${p.slice(0, 40)}…` : p} selected={focus === p} onPress={() => (setFocus(p), run(p))} />
            ))}
          </ChipGroup>
        </Card>
      ) : null}
      <Card>
        {text ? <RichContent text={text} /> : state === 'streaming' ? <Skeleton height={60} /> : null}
        {error ? <Banner kind="warning" message={error} action={{ label: t('global.retry'), onPress: () => run(focus) }} /> : null}
        <PageChips sources={citations} subjectId={capture.match?.subject_id} max={6} />
        {state === 'done' ? <AiBadge general={!capture.match} /> : null}
      </Card>
      {state === 'done' ? <AfterActions capture={capture} text={text} citations={citations} canSaveQuestion={capture.content_type === 'exercise'} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- CAM-02 solve

export function SolvePanel({ capture }: { capture: CaptureRow }) {
  const overlay = useOverlay();
  const online = useOnline();
  const { colors: c } = useTheme();
  const questions = capture.detected_questions ?? [];
  const [index, setIndex] = useState<number | null>(questions.length > 1 ? null : 0);
  const [ladder, setLadder] = useState<SolveRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [verdict, setVerdict] = useState<{ correct: boolean; message: string } | null>(null);
  const [solution, setSolution] = useState<{ text: string; streaming: boolean; citations: Citation[] } | null>(null);
  const [final, setFinal] = useState<{ answer: string; why_others_wrong: { option: string; reason: string }[]; uncertain_step?: number | null } | null>(null);
  const hintLabels = options('cam.hint');

  const reveal = async (kind: 'hint' | 'next_hint') => {
    if (index === null) return;
    setBusy(true);
    try {
      const res = await captureAct<SolveRes>({ capture_id: capture.id, intent: 'solve', question_index: index, reveal: kind });
      setLadder(res);
      if (res.final) setFinal(res.final);
    } catch (e) {
      overlay.snack(errorMessage((e as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      const res = await captureAct<Extract<CaptureActRes, { intent: 'check_answer' }>>({ capture_id: capture.id, intent: 'check_answer', answer: answer.trim() });
      setVerdict({ correct: res.correct, message: res.correct ? t('cam.correct') : t('cam.not_yet') });
    } catch (e) {
      overlay.snack(errorMessage((e as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  };

  const showSolution = () => {
    if (index === null) return;
    setSolution({ text: '', streaming: true, citations: [] });
    const h = streamCaptureSolution(capture.id, index, {
      onDelta: (d) => setSolution((s) => (s ? { ...s, text: s.text + d } : s)),
      onCitation: (ci) => setSolution((s) => (s ? { ...s, citations: [...s.citations, ci] } : s)),
      onDone: (d) => {
        setSolution((s) => (s ? { ...s, streaming: false } : s));
        const r = d.result as { final?: typeof final } | undefined;
        if (r?.final) setFinal(r.final);
      },
      onError: (e) => {
        setSolution(null);
        overlay.snack(errorMessage(e.code));
      },
    });
    h.done.catch((e: { code?: string }) => {
      setSolution(null);
      overlay.snack(errorMessage(e.code));
    });
  };

  if (index === null) {
    return (
      <View style={{ gap: space.md }}>
        <Text variant="heading">{t('cam.multiple', { n: questions.length })}</Text>
        {questions.map((q) => (
          <ListItem key={q.index} icon="document-text-outline" title={`${q.label} ${q.preview}`} subtitle={q.complete ? undefined : t('cam.partial_short')} onPress={() => setIndex(q.index)} />
        ))}
      </View>
    );
  }

  const question = questions[index];
  return (
    <View style={{ gap: space.md }}>
      <MatchLine capture={capture} />
      {question && !question.complete ? <Banner kind="warning" message={t('cam.partial_short')} /> : null}
      {!ladder && !solution ? (
        <Button icon="bulb-outline" label={hintLabels[0] ?? 'Me ajuda a resolver'} loading={busy} disabled={!online} onPress={() => void reveal('hint')} />
      ) : null}
      {ladder ? (
        <Card>
          {ladder.hints.map((h) => (
            <View key={h.level} style={{ gap: space.xs }}>
              <Text variant="label" tone="accent">
                {t('cam.hint_of', { i: h.level, n: ladder.total_levels })}
              </Text>
              <RichContent text={h.text_md} />
            </View>
          ))}
          {ladder.assumptions.length ? <Text variant="bodySmall" tone="secondary">{t('cam.assumptions', { list: ladder.assumptions.join('; ') })}</Text> : null}
          {!final && ladder.hint_level < ladder.total_levels ? (
            <Button variant="tonal" label={hintLabels[2] ?? 'Mais uma dica'} loading={busy} onPress={() => void reveal('next_hint')} />
          ) : null}
        </Card>
      ) : null}
      {!final ? (
        <Card tone="outline">
          <Text variant="label">{hintLabels[3] ?? 'Tentar responder'}</Text>
          <Row>
            <View style={{ flex: 1 }}>
              <TextField value={answer} onChangeText={setAnswer} placeholder={t('cam.answer_placeholder')} accessibilityLabel={t('cam.answer_placeholder')} />
            </View>
            <MicButton onText={(said) => setAnswer((v) => appendTranscript(v, said))} />
          </Row>
          <Button label={t('cam.check')} loading={busy} disabled={!answer.trim() || !online} onPress={() => void check()} />
          {verdict ? <Banner kind={verdict.correct ? 'success' : 'warning'} message={verdict.message} /> : null}
        </Card>
      ) : null}
      {solution ? (
        <Card>
          {solution.text ? <RichContent text={solution.text} /> : <Skeleton height={60} />}
          <PageChips sources={solution.citations} subjectId={capture.match?.subject_id} max={6} />
          {!solution.streaming ? <AiBadge general={!capture.match} /> : null}
        </Card>
      ) : !final ? (
        <Button variant="text" label={hintLabels[4] ?? 'Ver resolução completa'} disabled={!online} onPress={showSolution} />
      ) : null}
      {final ? (
        <View style={{ borderLeftWidth: 4, borderColor: c.success, paddingLeft: space.md, gap: space.xs, borderRadius: radius.sm }}>
          <Text variant="label">{t('cam.final_answer')}</Text>
          <RichContent text={final.answer} />
          {final.why_others_wrong.map((w) => (
            <Text key={w.option} variant="bodySmall" tone="secondary">
              {w.option}) {w.reason}
            </Text>
          ))}
          {final.uncertain_step ? <Banner kind="warning" message={t('cam.uncertain_step', { n: final.uncertain_step })} /> : null}
        </View>
      ) : null}
      {final || verdict?.correct ? <AfterActions capture={capture} text={solution?.text ?? final?.answer ?? ''} citations={solution?.citations ?? []} canSaveQuestion /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- CAM-01.5 add to a subject

export function AddToSubjectPanel({ capture }: { capture: CaptureRow }) {
  const overlay = useOverlay();
  const subjects = useSubjects();
  const [picked, setPicked] = useState<string | null>(capture.match?.subject_id ?? capture.subject_id);
  const [busy, setBusy] = useState(false);
  const subject = subjects.data?.find((s) => s.id === picked);
  const shared = !!subject?.owner_class_group_id;
  const add = async () => {
    if (!picked) return;
    if (shared && !(await overlay.confirm({ title: t('cam.add_title'), message: t('cam.shared_warning'), confirmLabel: t('cam.add_confirm') }))) return;
    setBusy(true);
    try {
      await captureAct({ capture_id: capture.id, intent: 'add_to_subject', subject_id: picked });
      router.replace({ pathname: '/subjects/[subjectId]/processing', params: { subjectId: picked } });
    } catch (e) {
      const code = (e as { code?: string }).code;
      overlay.snack(code === 'forbidden' ? t('cam.faces_required') : code === 'duplicate_document' ? t('cam.duplicate') : errorMessage(code));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space.md }}>
      <Text variant="heading">{t('cam.add_title')}</Text>
      {capture.match ? <Text tone="secondary">{t('cam.add_suggested', { label: capture.match.label })}</Text> : null}
      {(subjects.data ?? []).map((s) => (
        <ListItem key={s.id} title={s.name} icon={picked === s.id ? 'radio-button-on' : 'radio-button-off'} right={<SubjectBadge color={s.color} icon={s.icon} size={28} />} onPress={() => setPicked(s.id)} />
      ))}
      {shared ? <Banner kind="warning" message={t('cam.shared_warning')} /> : null}
      <Button label={t('cam.add_confirm')} loading={busy} disabled={!picked} onPress={() => void add()} />
    </View>
  );
}

// ---------------------------------------------------------------- CAM-03 transcription review + grading

/** themeId: the ENEM redação theme picked in the editor (grade_essay from S-ENEM Redação). */
export function TranscriptionReview({ capture, questionId, themeId, onGraded }: { capture: CaptureRow; questionId?: string; themeId?: string; onGraded: (essayId: string, feedback: SchoolEssayFeedback | null) => void }) {
  const { colors: c, type } = useTheme();
  const overlay = useOverlay();
  const online = useOnline();
  const original = capture.transcription ?? '';
  const [text, setText] = useState(capture.confirmed_text ?? original);
  const [questionText, setQuestionText] = useState('');
  const [maxPoints, setMaxPoints] = useState('10');
  const [busy, setBusy] = useState(false);
  const markers = parseTranscriptionMarkers(original);
  const ratio = editRatio(original, text);

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await captureAct<Extract<CaptureActRes, { next: 'grade-essay' }>>({
        capture_id: capture.id,
        intent: capture.intent === 'grade_essay' ? 'grade_essay' : 'grade_answer',
        confirmed_text: text,
        ...(questionId ? { question_id: questionId } : {}),
        ...(!questionId && questionText.trim() ? { question_text: questionText.trim(), max_points: Number(maxPoints.replace(',', '.')) || 10 } : {}),
        ...(capture.subject_id ? { subject_id: capture.subject_id } : {}),
        ...(themeId && capture.intent === 'grade_essay' ? { theme_id: themeId } : {}),
      });
      const graded = await gradeEssay(res.essay_id);
      onGraded(res.essay_id, graded.mode === 'sync' ? graded.essay.feedback : null);
    } catch (e) {
      overlay.snack(errorMessage((e as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.md }}>
      <Text variant="heading">{t('cam.transcription.title')}</Text>
      <Text tone="secondary">{t('cam.transcription.rule')}</Text>
      {markers.illegible > 0 ? <Banner kind="info" message={t('cam.legibility', { n: markers.illegible })} /> : null}
      <TextInput
        multiline
        value={text}
        onChangeText={setText}
        accessibilityLabel={t('cam.transcription.title')}
        style={[type('body'), { borderWidth: 1.5, borderColor: c.border, borderRadius: radius.md, padding: space.md, minHeight: 240, textAlignVertical: 'top', color: c.textPrimary }]}
      />
      {ratio > HEAVY_EDIT_RATIO ? <Text variant="bodySmall" tone="warning">{t('cam.transcription.edited')}</Text> : null}
      {!questionId && capture.intent === 'grade_answer' ? (
        <Card tone="outline">
          <TextField label={t('essay.question_label')} value={questionText} onChangeText={setQuestionText} multiline placeholder={t('essay.question_placeholder')} />
          <TextField label={t('essay.max_points')} value={maxPoints} onChangeText={setMaxPoints} keyboardType="decimal-pad" />
        </Card>
      ) : null}
      <Button label={t('cam.transcription.confirm')} loading={busy} disabled={!text.trim() || !online || (!questionId && capture.intent === 'grade_answer' && !questionText.trim())} onPress={() => void confirm()} />
    </View>
  );
}
