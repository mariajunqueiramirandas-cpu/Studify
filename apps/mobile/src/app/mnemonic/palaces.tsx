import { MNEMONICS } from '@studify/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, EmptyState, IconButton, Row, Screen, Text, TextField, useOnline, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { deletePalace, savePalace, usePalaces } from '../../features/mnemonics/api';
import { useDb } from '../../db/DatabaseProvider';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

/** MEM-06.5 Palácios da memória: a place the student knows, as an ordered list of up to 20 loci, reused later. */
export default function Palaces() {
  const palaces = usePalaces();
  const db = useDb();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const [editing, setEditing] = useState<{ id?: string; name: string; loci: string[] } | null>(null);
  const [locus, setLocus] = useState('');

  if (editing) {
    const valid = editing.name.trim().length > 0 && editing.loci.length >= MNEMONICS.minLoci;
    return (
      <Screen title={editing.id ? editing.name : t('palace.new')} onBack={() => setEditing(null)}>
        <TextField label={t('palace.name')} placeholder={t('palace.name_placeholder')} value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} maxLength={60} />
        <Text variant="label">{t('palace.loci', { n: editing.loci.length, max: MNEMONICS.maxLoci })}</Text>
        {editing.loci.map((l, i) => (
          <Row key={`${l}-${i}`}>
            <Text style={{ flex: 1 }}>
              {i + 1}. {l}
            </Text>
            <IconButton icon="close" label={t('global.remove')} onPress={() => setEditing({ ...editing, loci: editing.loci.filter((_, j) => j !== i) })} />
          </Row>
        ))}
        {editing.loci.length < MNEMONICS.maxLoci ? (
          <Row>
            <View style={{ flex: 1 }}>
              <TextField label={t('palace.locus')} placeholder={t('palace.locus_placeholder')} value={locus} onChangeText={setLocus} maxLength={60} onSubmitEditing={() => (locus.trim() ? (setEditing({ ...editing, loci: [...editing.loci, locus.trim()] }), setLocus('')) : undefined)} />
            </View>
            <IconButton icon="add" label={t('palace.add_locus')} onPress={() => (locus.trim() ? (setEditing({ ...editing, loci: [...editing.loci, locus.trim()] }), setLocus('')) : undefined)} />
          </Row>
        ) : null}
        <Button
          label={t('palace.save')}
          disabled={!valid || !online}
          onPress={() =>
            void savePalace(db, userId!, { id: editing.id, name: editing.name.trim(), loci: editing.loci })
              .then(() => setEditing(null))
              .catch((e: unknown) => overlay.snack(messageFor(e)))
          }
        />
      </Screen>
    );
  }

  return (
    <Screen title={t('palace.title')} onBack={() => router.back()}>
      <Text tone="secondary">{t('palace.intro')}</Text>
      {(palaces.data ?? []).length === 0 ? <EmptyState icon="home-outline" message={t('palace.empty')} /> : null}
      {(palaces.data ?? []).map((p) => (
        <Card key={p.id} onPress={() => setEditing({ id: p.id, name: p.name, loci: p.loci })}>
          <Row>
            <Text variant="heading" style={{ flex: 1 }}>
              {p.name}
            </Text>
            <IconButton icon="trash-outline" label={t('global.remove')} onPress={() => void deletePalace(db, p.id).catch((e: unknown) => overlay.snack(messageFor(e)))} />
          </Row>
          <Text variant="bodySmall" tone="secondary">
            {p.loci.join(' → ')}
          </Text>
        </Card>
      ))}
      <Button icon="add" label={t('palace.new')} disabled={!online} onPress={() => setEditing({ name: '', loci: [] })} />
    </Screen>
  );
}
