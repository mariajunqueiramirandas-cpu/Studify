import type { VisualGenerateRes } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { AiBadge, Banner, Button, Chip, ChipGroup, EmptyState, GenerationStatus, PageChips, Screen, Text, ZoomableView, useOnline } from '../../components';
import { generateVisual, VISUAL_KINDS, type VisualKind } from '../../features/visuals/api';
import { VisualView } from '../../features/visuals/VisualView';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

/** S-LRN Visual viewer (LRN-05.2–05.4): "Ver em diagrama" — automatic type, or one the student picks. */
export default function VisualScreen() {
  const { nodeId, subjectId, title } = useLocalSearchParams<{ nodeId: string; subjectId?: string; title?: string }>();
  const online = useOnline();
  const [kind, setKind] = useState<VisualKind | null>(null);
  const [state, setState] = useState<{ loading: boolean; res: VisualGenerateRes | null; error: string | null; startedAt: number }>(() => ({ loading: true, res: null, error: null, startedAt: Date.now() }));

  useEffect(() => {
    let alive = true;
    generateVisual(nodeId, kind ?? undefined)
      .then((res) => alive && setState((s) => ({ ...s, loading: false, res, error: null })))
      .catch((e: unknown) => alive && setState((s) => ({ ...s, loading: false, res: null, error: messageFor(e, t('error.generation')) })));
    return () => {
      alive = false;
    };
  }, [nodeId, kind]);

  const pick = (k: VisualKind | null) => {
    setState({ loading: true, res: null, error: null, startedAt: Date.now() });
    setKind(k);
  };
  const res = state.res;
  return (
    <Screen title={title ?? t('visual.title')} onBack={() => router.back()} actions={<AiBadge />}>
      {!online ? <Banner kind="warning" message={t('visual.offline')} /> : null}
      <ChipGroup>
        <Chip label={t('visual.auto')} selected={kind === null} onPress={() => pick(null)} />
        {VISUAL_KINDS.map((k) => (
          <Chip key={k} label={t(`visual.kind.${k}`)} selected={kind === k} onPress={() => pick(k)} />
        ))}
      </ChipGroup>
      {state.loading ? <GenerationStatus title={t('visual.drawing_title')} detail={kind ? t(`visual.kind.${kind}`) : null} startedAt={state.startedAt} slowAfterS={25} /> : null}
      {state.error ? <GenerationStatus title={t('visual.drawing_title')} error={state.error} onRetry={online ? () => pick(kind) : undefined} /> : null}
      {res && !res.fits ? <EmptyState icon="shapes-outline" message={res.reason} /> : null}
      {res && res.fits ? (
        <View style={{ gap: space.md }} accessible accessibilityLabel={res.visual.alt_text}>
          <Text variant="heading">{res.visual.title}</Text>
          <ZoomableView>
            <VisualView spec={res.visual.spec} subjectId={subjectId ?? null} />
          </ZoomableView>
          <Text variant="caption" tone="secondary">
            {t('visual.hint')}
          </Text>
          <Text variant="bodySmall" tone="secondary">
            {res.visual.alt_text}
          </Text>
          <PageChips sources={res.visual.source_pages} subjectId={subjectId ?? null} max={4} />
        </View>
      ) : null}
      {res && !res.fits && kind === null ? <Button variant="text" label={t('visual.try_type')} onPress={() => pick('flowchart')} /> : null}
    </Screen>
  );
}
