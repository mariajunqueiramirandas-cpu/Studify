import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { EmptyState, ListItem, Screen, SkeletonList, Text, TextField } from '../../../../components';
import { useGlossary, type GlossaryTerm } from '../../../../features/learn/api';
import { t } from '../../../../i18n';
import { space } from '../../../../theme';
import { TermSheet } from '../../../../features/learn/TermSheet';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** S-MAT-12 Glossário — A–Z with search (LRN-02). */
export default function Glossary() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const glossary = useGlossary(subjectId);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState<GlossaryTerm | null>(null);
  const groups = useMemo(() => {
    const f = fold(q.trim());
    const list = (glossary.data ?? []).filter((g) => !f || fold(g.term).includes(f) || g.aliases.some((a) => fold(a).includes(f)));
    const map = new Map<string, GlossaryTerm[]>();
    for (const g of list) {
      const letter = fold(g.term).charAt(0).toUpperCase() || '#';
      map.set(letter, [...(map.get(letter) ?? []), g]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [glossary.data, q]);

  return (
    <Screen title={t('glossary.title')}>
      <TextField placeholder={t('glossary.search')} value={q} onChangeText={setQ} accessibilityLabel={t('glossary.search')} />
      {glossary.isLoading ? <SkeletonList rows={6} height={48} /> : null}
      {glossary.isFetched && !glossary.data?.length ? <EmptyState icon="text-outline" message={t('glossary.empty')} /> : null}
      {groups.map(([letter, terms]) => (
        <View key={letter} style={{ gap: space.xs }}>
          <Text variant="heading" tone="accent" accessibilityRole="header">
            {letter}
          </Text>
          {terms.map((g) => (
            <ListItem key={g.id} title={g.term} subtitle={g.definition} onPress={() => setTerm(g)} />
          ))}
        </View>
      ))}
      <TermSheet term={term} visible={!!term} onClose={() => setTerm(null)} subjectId={subjectId} />
    </Screen>
  );
}
