import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { AiBadge, BottomSheet, Button, Chip, ChipGroup, GenerationStatus, PageChips, RichContent, Text, useOnline } from '../../components';
import { messageFor } from '../../api/messages';
import { useSession } from '../auth/session';
import { options, t } from '../../i18n';
import { space } from '../../theme';
import { EXPLAIN_STYLES, sendExplanationFeedback, streamExplain, type Citation, type ExplainStyle } from './api';

type Target = Parameters<typeof streamExplain>[0];

/** S-MAT-11 "Explica de outro jeito" (LRN-03): 4 styles, streamed, with 📄 and "Ajudou?". */
export function ExplainSheet({ visible, onClose, target, subjectId }: { visible: boolean; onClose: () => void; target: Target | null; subjectId?: string }) {
  const { userId } = useSession();
  const online = useOnline();
  const [style, setStyle] = useState<ExplainStyle | null>(null);
  const [text, setText] = useState('');
  const [cites, setCites] = useState<Citation[]>([]);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [explanationId, setExplanationId] = useState<string | null>(null);
  const [rated, setRated] = useState(false);
  const handle = useRef<{ cancel: () => void } | null>(null);
  const labels = options('notes.explain_styles');

  useEffect(() => {
    if (!visible) {
      handle.current?.cancel();
      setStyle(null);
      setText('');
      setCites([]);
      setStatus('idle');
      setRated(false);
    }
  }, [visible]);

  const run = (s: ExplainStyle, forceNew = false) => {
    if (!target) return;
    handle.current?.cancel();
    setStyle(s);
    setText('');
    setCites([]);
    setRated(false);
    setFailure(null);
    setStatus('streaming');
    handle.current = streamExplain(
      target,
      s,
      {
        onMeta: (m) => setExplanationId((m.explanation_id as string) ?? null),
        onDelta: (d) => setText((x) => x + d),
        onCitation: (c) => setCites((x) => [...x, c]),
        onDone: (d) => {
          if (d.stop_reason === 'refusal') setFailure(t('ai.refusal'));
          setStatus(d.stop_reason === 'refusal' ? 'error' : 'done');
        },
        // What happened (the budget, the network, the server) instead of always "I can't answer that".
        onError: (e) => {
          setFailure(messageFor(e, t('error.generation')));
          setStatus('error');
        },
      },
      forceNew,
    );
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('notes.explain')}>
      <ChipGroup>
        {EXPLAIN_STYLES.map((s, i) => (
          <Chip key={s} label={labels[i] ?? s} selected={style === s} disabled={!online} onPress={() => run(s)} />
        ))}
      </ChipGroup>
      {!online ? <Text tone="secondary">{t('offline.ai_disabled')}</Text> : null}
      {status === 'streaming' && !text ? <GenerationStatus compact title={t('notes.explain_writing')} slowAfterS={20} /> : null}
      {text ? (
        <View style={{ gap: space.sm }}>
          <RichContent variant="reading" text={text} />
          <PageChips sources={cites} subjectId={subjectId} />
          <AiBadge />
        </View>
      ) : null}
      {status === 'error' ? <GenerationStatus compact title={t('notes.explain')} error={failure ?? t('ai.refusal')} onRetry={style && online ? () => run(style) : undefined} /> : null}
      {status === 'done' && !rated ? (
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('notes.explain_helped')}</Text>
          <ChipGroup>
            <Chip
              label={t('global.yes')}
              onPress={() => {
                setRated(true);
                if (explanationId && userId) void sendExplanationFeedback(userId, explanationId, true);
              }}
            />
            <Chip
              label="Não, tenta outro jeito"
              onPress={() => {
                if (explanationId && userId) void sendExplanationFeedback(userId, explanationId, false);
                if (style) run(style, true);
              }}
            />
          </ChipGroup>
        </View>
      ) : null}
      {rated ? <Text tone="secondary">{t('notes.thanks')}</Text> : null}
      <Button variant="text" label={t('global.close')} onPress={onClose} />
    </BottomSheet>
  );
}
