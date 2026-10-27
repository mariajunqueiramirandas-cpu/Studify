import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Button, Card, Chip, ChipGroup, EmptyState, ListItem, NumberStepper, Screen, Section, SkeletonList, Text, TextField, useOnline, useOverlay } from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { useClassSubjects } from '../../../../../features/class/api';
import { createDividePlan, useDividePlans, useSubjectTopics } from '../../../../../features/class/turma5';
import { t } from '../../../../../i18n';

/** SOC-06.1 Dividir e conquistar: the Turma's divisões and a new one for a subject's topics. */
export default function DivideList() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const plans = useDividePlans(classGroupId);
  const subjects = useClassSubjects(classGroupId);
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const [creating, setCreating] = useState(false);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [maxClaims, setMaxClaims] = useState(3);
  const topics = useSubjectTopics(subjectId ?? undefined);

  if (creating) {
    return (
      <Screen
        title={t('divide.new')}
        onBack={() => setCreating(false)}
        footer={
          <ActionBar>
            <Button
              label={t('divide.create')}
              disabled={!online || !subjectId || !title.trim() || picked.size === 0}
              onPress={() =>
                void createDividePlan(userId!, { classGroupId, subjectId: subjectId!, title: title.trim(), nodeIds: [...picked], maxClaims })
                  .then((id) => (setCreating(false), void plans.refetch(), router.push({ pathname: '/class/[classGroupId]/divide/[planId]', params: { classGroupId, planId: id } })))
                  .catch(() => overlay.snack(t('error.generic')))
              }
            />
          </ActionBar>
        }
      >
        <TextField label={t('divide.title_label')} placeholder={t('divide.title_placeholder')} value={title} onChangeText={setTitle} maxLength={80} />
        <Text variant="label">{t('divide.subject')}</Text>
        <ChipGroup>
          {(subjects.data ?? []).map((s) => (
            <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => (setSubjectId(s.id), setPicked(new Set()))} />
          ))}
        </ChipGroup>
        {subjectId ? (
          <Section title={t('divide.topics', { n: picked.size })}>
            {topics.isLoading ? <SkeletonList rows={3} /> : null}
            {(topics.data ?? []).map((tp) => (
              <ListItem
                key={tp.id}
                icon={picked.has(tp.id) ? 'checkbox' : 'square-outline'}
                title={tp.title}
                onPress={() =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (n.has(tp.id)) n.delete(tp.id);
                    else if (n.size < 60) n.add(tp.id);
                    return n;
                  })
                }
              />
            ))}
          </Section>
        ) : null}
        <NumberStepper label={t('divide.max_claims')} value={maxClaims} min={1} max={10} onChange={setMaxClaims} />
      </Screen>
    );
  }

  const list = plans.data ?? [];
  return (
    <Screen title={t('divide.title')} onBack={() => router.back()} onRefresh={plans.refetch} refreshing={plans.isRefetching} footer={<ActionBar><Button icon="add" label={t('divide.new')} disabled={!online} onPress={() => setCreating(true)} /></ActionBar>}>
      <Text tone="secondary">{t('divide.intro')}</Text>
      {plans.isLoading ? <SkeletonList rows={3} /> : null}
      {!plans.isLoading && list.length === 0 ? <EmptyState icon="git-branch-outline" message={t('divide.empty')} /> : null}
      {list.map((p) => (
        <Card key={p.id} onPress={() => router.push({ pathname: '/class/[classGroupId]/divide/[planId]', params: { classGroupId, planId: p.id } })}>
          <Text variant="heading">{p.title}</Text>
          <Text variant="bodySmall" tone="secondary">
            {t(`divide.status.${p.status}`)} · {t('divide.claimed', { k: Object.keys(p.assignments).length, n: p.node_ids.length })}
          </Text>
        </Card>
      ))}
    </Screen>
  );
}
