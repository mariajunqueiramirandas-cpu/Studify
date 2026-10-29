import type { MnemonicOption, MnemonicType } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AiBadge, Banner, Button, Card, Chip, ChipGroup, EmptyState, GenerationStatus, Screen, Text, TextField, useOnline, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { saveMnemonic, suggestMnemonics, useCardText, usePalaces } from '../../features/mnemonics/api';
import { useDb } from '../../db/DatabaseProvider';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

const TYPES: Array<MnemonicType | 'any'> = ['any', 'acronym', 'phrase', 'rhyme', 'story', 'palace', 'keyword'];

/**
 * S-MEM Estúdio de Mnemônicos (MEM-06.1–06.5): pick a type (or let the AI choose), see 3 options, edit one and save
 * it to the card or concept. "Outras ideias" asks for a new round without repeating the titles already shown.
 */
export default function MnemonicStudio() {
  const params = useLocalSearchParams<{ cardId?: string; nodeId?: string; items?: string; title?: string }>();
  const items = params.items ? (JSON.parse(params.items) as string[]) : undefined;
  const card = useCardText(params.cardId);
  const palaces = usePalaces();
  const db = useDb();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const [type, setType] = useState<MnemonicType | 'any'>('any');
  const [palaceId, setPalaceId] = useState<string | null>(null);
  const [options, setOptions] = useState<MnemonicOption[]>([]);
  const [shown, setShown] = useState<string[]>([]);
  const [chosen, setChosen] = useState<MnemonicOption | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'suggest' | 'save' | null>(null);

  const suggest = async (more: boolean) => {
    if (type === 'palace' && !palaceId) {
      overlay.snack(t('mnemonic.pick_palace'));
      return;
    }
    setBusy('suggest');
    setChosen(null);
    try {
      const res = await suggestMnemonics({
        ...(params.cardId ? { card_id: params.cardId } : { node_id: params.nodeId }),
        type,
        ...(type === 'palace' && palaceId ? { palace_id: palaceId } : {}),
        ...(items ? { items } : {}),
        ...(more ? { exclude_titles: shown } : {}),
      });
      setOptions(res.options);
      setShown((s) => [...s, ...res.options.map((o) => o.title)].slice(-12));
    } catch (e) {
      overlay.snack(messageFor(e, t('error.generation')));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!chosen || !userId) return;
    setBusy('save');
    try {
      await saveMnemonic(db, userId, { cardId: params.cardId, nodeId: params.cardId ? undefined : params.nodeId }, { ...chosen, content: { ...chosen.content, text: text.trim() || chosen.content.text } }, palaceId);
      overlay.snack(t('mnemonic.saved'));
      router.back();
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={t('mnemonic.title')} onBack={() => router.back()} actions={<AiBadge />}>
      {!online ? <Banner kind="warning" message={t('mnemonic.offline')} /> : null}
      {card.data ? (
        <Card tone="soft">
          <Text variant="label">{card.data.front}</Text>
          <Text variant="bodySmall" tone="secondary">
            {card.data.back}
          </Text>
        </Card>
      ) : params.title ? (
        <Card tone="soft">
          <Text variant="label">{params.title}</Text>
        </Card>
      ) : null}
      {items ? <Text variant="bodySmall">{items.join(' · ')}</Text> : null}
      <Text variant="label">{t('mnemonic.type')}</Text>
      <ChipGroup>
        {TYPES.map((k) => (
          <Chip key={k} label={t(`mnemonic.types.${k}`)} selected={type === k} onPress={() => setType(k)} />
        ))}
      </ChipGroup>
      {type === 'palace' ? (
        <View style={{ gap: space.sm }}>
          <ChipGroup>
            {(palaces.data ?? []).map((p) => (
              <Chip key={p.id} label={`${p.name} (${p.loci.length})`} selected={palaceId === p.id} onPress={() => setPalaceId(p.id)} />
            ))}
          </ChipGroup>
          <Button compact variant="text" icon="home-outline" label={t('mnemonic.palaces')} onPress={() => router.push('/mnemonic/palaces')} />
        </View>
      ) : null}
      <Button icon="sparkles-outline" label={options.length ? t('mnemonic.more') : t('mnemonic.suggest')} loading={busy === 'suggest'} disabled={!online} onPress={() => void suggest(options.length > 0)} />
      {busy === 'suggest' ? <GenerationStatus title={t('mnemonic.suggesting')} slowAfterS={20} /> : null}
      {!busy && options.length === 0 ? <EmptyState icon="bulb-outline" message={t('mnemonic.empty')} /> : null}
      {options.map((o) => (
        <Card key={o.title} tone={chosen?.title === o.title ? 'soft' : 'default'} onPress={() => (setChosen(o), setText(o.content.text))}>
          <Text variant="caption" tone="secondary">
            {t(`mnemonic.types.${o.type}`)}
          </Text>
          <Text variant="heading">{o.title}</Text>
          <Text>{o.content.text}</Text>
          {o.content.loci?.map((l) => (
            <Text key={l.locus} variant="bodySmall">
              📍 {l.locus}: {l.item} — {l.image}
            </Text>
          ))}
          {o.content.how_to_use ? (
            <Text variant="caption" tone="secondary">
              {o.content.how_to_use}
            </Text>
          ) : null}
        </Card>
      ))}
      {chosen ? (
        <Card>
          <TextField label={t('mnemonic.edit')} value={text} onChangeText={setText} multiline maxLength={1200} />
          <Button label={t('mnemonic.save')} loading={busy === 'save'} disabled={!online || !text.trim()} onPress={() => void save()} />
        </Card>
      ) : null}
    </Screen>
  );
}
