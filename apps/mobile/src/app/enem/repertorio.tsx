import { router } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Button, Card, Chip, ChipGroup, EmptyState, ErrorState, Row, Screen, SkeletonList, Text, TextField, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { deleteRepertorio, saveRepertorio, useRepertorio, type RepertorioItem } from '../../features/enem/api';
import { t } from '../../i18n';

const KINDS: RepertorioItem['kind'][] = ['data', 'quote', 'law', 'work', 'event'];

/** Repertório pessoal (ENM-05.5, ENM-09.5): saved data, quotes, laws and works, with source and verification. */
export default function Repertorio() {
  const list = useRepertorio();
  const { userId } = useSession();
  const overlay = useOverlay();
  const [kind, setKind] = useState<RepertorioItem['kind']>('data');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');

  return (
    <Screen title={t('repertorio.title')} onBack={() => router.back()}>
      <Card tone="soft">
        <ChipGroup>
          {KINDS.map((k) => (
            <Chip key={k} label={t(`repertorio.kind.${k}`)} selected={kind === k} onPress={() => setKind(k)} />
          ))}
        </ChipGroup>
        <TextField label={t('repertorio.text')} value={text} onChangeText={setText} multiline maxLength={2000} />
        <TextField label={t('repertorio.source')} value={source} onChangeText={setSource} autoCapitalize="none" keyboardType="url" />
        <Button
          label={t('repertorio.add')}
          disabled={text.trim().length < 3}
          onPress={() =>
            void saveRepertorio(userId!, { kind, text: text.trim(), sourceUrl: /^https?:\/\//.test(source.trim()) ? source.trim() : null })
              .then(() => (setText(''), setSource(''), list.refetch()))
              .catch(() => overlay.snack(t('error.generic')))
          }
        />
      </Card>
      {list.isError ? <ErrorState onRetry={list.refetch} /> : null}
      {list.isLoading ? <SkeletonList rows={3} /> : null}
      {!list.isLoading && (list.data ?? []).length === 0 ? <EmptyState icon="bookmarks-outline" message={t('repertorio.empty')} /> : null}
      {(list.data ?? []).map((r) => (
        <Card key={r.id}>
          <Row>
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              {t(`repertorio.kind.${r.kind}`)} · {t(`repertorio.verified.${r.verified}`)}
            </Text>
            <Button compact variant="text" label={t('repertorio.remove')} onPress={() => void deleteRepertorio(r.id).then(() => list.refetch())} />
          </Row>
          <Text>{r.text}</Text>
          {r.source_url ? <Button compact variant="text" label={r.source_name ?? r.source_url} onPress={() => void Linking.openURL(r.source_url!)} /> : null}
        </Card>
      ))}
    </Screen>
  );
}
