// ✋ Perguntar (INT-01.8–01.11): the episode pauses, the student speaks or types, the hosts answer in 2–4 lines
// grounded in the segment's pages, the answer plays (cloud voices, or the device voice when the clip is late or
// missing) and the episode resumes 3 s before the pause point.
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, BottomSheet, Button, PageChips, Row, Text, TextField, useOnline } from '../../components';
import type { StreamHandle } from '../../api/functions';
import { t } from '../../i18n';
import { space } from '../../theme';
import type { Citation } from '../learn/api';
import { openTutor } from '../tutor/open';
import { MicButton } from '../voice/VoiceButtons';
import { appendTranscript } from '../voice/speech-text';
import { askHosts } from './api';
import { interrupt, playClip, resumeAt, speakLines, usePodcastPlayer } from './player';
import { lineAt } from './timeline';

interface Answer {
  lines: { speaker: 'bia' | 'caio'; text: string }[];
  text: string;
  citations: Citation[];
  outOfMaterial: boolean;
  phase: 'thinking' | 'recording' | 'playing' | 'resuming' | 'done';
}

export function HandSheet({ visible, onClose, episodeId, subjectId, onAnswered }: { visible: boolean; onClose: () => void; episodeId: string; subjectId: string; onAnswered: () => void }) {
  const online = useOnline();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<StreamHandle | null>(null);

  // The player screen remounts the sheet for every ✋ (key), so each question starts clean.
  useEffect(() => {
    if (visible) interrupt();
    return () => handle.current?.cancel();
  }, [visible]);

  const finish = (resumeMs: number) => {
    setAnswer((a) => (a ? { ...a, phase: 'resuming' } : a));
    setTimeout(() => {
      onClose();
      void resumeAt(resumeMs);
    }, 1200);
  };

  const send = (input: 'voice' | 'text') => {
    const text = question.trim();
    const { track, positionMs } = usePodcastPlayer.getState();
    if (!text || !track) return;
    const line = track.lines[lineAt(track.lines, positionMs)];
    setError(null);
    setAnswer({ lines: [], text: '', citations: [], outOfMaterial: false, phase: 'thinking' });
    const h = askHosts(
      { episode_id: episodeId, position_ms: Math.round(positionMs), question_text: text, input_mode: input, ...(line ? { segment_id: line.segmentId } : {}) },
      {
        onDelta: (d) => setAnswer((a) => (a ? { ...a, text: a.text + d } : a)),
        onCitation: (c) => setAnswer((a) => (a ? { ...a, citations: [...a.citations, c] } : a)),
        onStatus: () => setAnswer((a) => (a ? { ...a, phase: 'recording' } : a)),
        onDone: (d) => {
          const r = d.result as { lines: Answer['lines']; out_of_material: boolean; answer_audio_url: string | null; resume_at_ms: number } | undefined;
          if (!r) {
            setAnswer(null);
            setError(t('error.generation'));
            return;
          }
          setAnswer((a) => ({ lines: r.lines, text: a?.text ?? '', citations: a?.citations ?? [], outOfMaterial: r.out_of_material, phase: 'playing' }));
          onAnswered();
          if (r.answer_audio_url) playClip(r.answer_audio_url, () => finish(r.resume_at_ms));
          else speakLines(r.lines, () => finish(r.resume_at_ms));
        },
      },
    );
    handle.current = h;
    h.done.catch((e: { code?: string }) => {
      if (e.code === 'cancelled') return;
      setAnswer(null);
      setError(e.code === 'rate_limited' ? t('podcast.hand_cap') : e.code === 'budget_exhausted' ? t('budget.user_daily') : t('error.generation'));
    });
  };

  const close = () => {
    handle.current?.cancel();
    onClose();
    if (!answer || answer.phase === 'thinking') void resumeAt(Math.max(0, usePodcastPlayer.getState().positionMs - 3000));
  };

  return (
    <BottomSheet visible={visible} onClose={close} title={t('podcast.ask')}>
      {!answer ? (
        <View style={{ gap: space.md }}>
          <Row>
            <View style={{ flex: 1 }}>
              <TextField value={question} onChangeText={setQuestion} placeholder={t('podcast.ask_type')} accessibilityLabel={t('podcast.ask_type')} multiline />
            </View>
            <MicButton disabled={!online} onText={(said) => setQuestion((v) => appendTranscript(v, said))} />
          </Row>
          <Button label={t('tutor.send')} disabled={!question.trim() || !online} onPress={() => send('text')} />
          {error ? (
            <Banner kind="warning" message={error} action={error === t('podcast.hand_cap') ? { label: t('podcast.ask_tutor'), onPress: () => (onClose(), openTutor({ type: 'subject', subject_id: subjectId }, { prefill: question })) } : undefined} />
          ) : null}
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          <Text variant="label" tone="secondary">
            {t('podcast.your_question')}: {question}
          </Text>
          {answer.lines.length
            ? answer.lines.map((l, i) => (
                <Text key={i}>
                  <Text weight="bold">{l.speaker === 'bia' ? 'Bia' : 'Caio'}: </Text>
                  {l.text}
                </Text>
              ))
            : <Text tone="secondary">{answer.text ? answer.text : t('podcast.hosts_thinking')}</Text>}
          <PageChips sources={answer.citations} subjectId={subjectId} />
          {answer.phase === 'recording' ? <Text variant="bodySmall" tone="secondary">{t('podcast.recording_answer')}</Text> : null}
          {answer.phase === 'resuming' ? <Text variant="bodySmall" tone="accent">{t('podcast.resume')}</Text> : null}
          {answer.outOfMaterial ? <Button compact variant="tonal" label={t('podcast.ask_tutor')} onPress={() => (onClose(), openTutor({ type: 'subject', subject_id: subjectId }, { prefill: question }))} /> : null}
        </View>
      )}
    </BottomSheet>
  );
}
