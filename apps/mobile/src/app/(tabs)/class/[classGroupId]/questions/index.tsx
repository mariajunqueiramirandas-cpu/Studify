import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Button, Card, EmptyState, Row, Screen, SegmentedControl, SkeletonList, Text, useOnline, useOverlay } from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { useClassGroup, useClassSubjects, useMembers } from '../../../../../features/class/api';
import { reviewPeerQuestion, usePeerQuestions, votePeerQuestion, type PeerQuestion } from '../../../../../features/class/turma5';
import { t } from '../../../../../i18n';
import { space } from '../../../../../theme';

type Tab = 'vote' | 'approved' | 'mine';

/** The correct answer as text, so members can judge the question before voting (SOC-07.3). */
function answerOf(q: PeerQuestion): string {
  const p = q.payload as { correct?: unknown; options?: Array<{ id: string; text: string }>; model_answer?: string; statement?: string };
  if (q.type === 'mcq_single') return p.options?.find((o) => o.id === p.correct)?.text ?? String(p.correct ?? '');
  if (q.type === 'true_false') return p.correct ? t('peer.true') : t('peer.false');
  return p.model_answer ?? '';
}

/** SOC-07 Perguntas da turma: vote 👍 on pending questions (3 approve), see approved ones and your own. */
export default function PeerQuestions() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const subjects = useClassSubjects(classGroupId);
  const subjectIds = (subjects.data ?? []).map((s) => s.id);
  const questions = usePeerQuestions(classGroupId, subjectIds);
  const cg = useClassGroup(classGroupId);
  const members = useMembers(classGroupId);
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const [tab, setTab] = useState<Tab>('vote');
  const nameOf = new Map((members.data ?? []).map((m) => [m.user_id, m.nickname ?? m.display_name ?? '—']));
  const all = questions.data?.list ?? [];
  const voted = questions.data?.voted ?? new Set<string>();
  const list = all.filter((q) => (tab === 'vote' ? q.review_status === 'pending' && q.author_id !== userId : tab === 'approved' ? q.review_status === 'approved' : q.author_id === userId));
  const act = (fn: () => Promise<string>, done: string) => void fn().then((s) => (overlay.snack(s === 'approved' ? t('peer.approved_now') : done), questions.refetch())).catch((e: { message?: string }) => overlay.snack(e.message ?? t('error.generic')));

  return (
    <Screen
      title={t('peer.title')}
      onBack={() => router.back()}
      onRefresh={questions.refetch}
      refreshing={questions.isRefetching}
      footer={
        <ActionBar>
          <Button icon="add" label={t('peer.new')} disabled={!online} onPress={() => router.push({ pathname: '/class/[classGroupId]/questions/new', params: { classGroupId } })} />
        </ActionBar>
      }
    >
      <SegmentedControl<Tab> value={tab} onChange={setTab} options={(['vote', 'approved', 'mine'] as const).map((k) => ({ value: k, label: t(`peer.tabs.${k}`) }))} />
      {questions.isLoading ? <SkeletonList rows={3} /> : null}
      {!questions.isLoading && list.length === 0 ? <EmptyState icon="help-buoy-outline" message={t(`peer.empty.${tab}`)} /> : null}
      {list.map((q) => (
        <Card key={q.id}>
          <Text variant="caption" tone="secondary">
            {q.author_anonymous || !q.author_id ? t('peer.anonymous') : t('peer.by', { name: nameOf.get(q.author_id) ?? '—' })} · {t(`peer.status.${q.review_status}`)}
          </Text>
          <Text>{q.stem}</Text>
          {q.type === 'mcq_single'
            ? ((q.payload as { options?: Array<{ id: string; text: string }> }).options ?? []).map((o) => (
                <Text key={o.id} variant="bodySmall">
                  {o.id}) {o.text}
                </Text>
              ))
            : null}
          <Text variant="bodySmall" tone="success">
            {t('peer.answer')}: {answerOf(q)}
          </Text>
          {tab === 'vote' ? (
            <Row wrap>
              <Button compact variant={voted.has(q.id) ? 'tonal' : 'secondary'} icon="thumbs-up-outline" label={voted.has(q.id) ? t('peer.voted') : t('peer.vote')} disabled={voted.has(q.id) || !online} onPress={() => act(() => votePeerQuestion(q.id), t('peer.vote_thanks'))} />
              {cg.data?.isMod ? (
                <View style={{ flexDirection: 'row', gap: space.xs }}>
                  <Button compact variant="text" label={t('peer.approve')} onPress={() => act(() => reviewPeerQuestion(q.id, true), t('peer.approved_now'))} />
                  <Button compact variant="text" label={t('peer.reject')} onPress={() => act(() => reviewPeerQuestion(q.id, false), t('peer.rejected_now'))} />
                </View>
              ) : null}
            </Row>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
