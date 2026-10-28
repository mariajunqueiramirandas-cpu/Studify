import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Section,
  ActionBar,
  AiBadge,
  Banner,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListItem,
  MarkdownView,
  PageChips,
  PctRing,
  RichContent,
  Row,
  Screen,
  SegmentedControl,
  Skeleton,
  Text,
  useOnline,
  useOverlay,
} from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { pageLabel } from '../../../../../features/common/format';
import { createUserCard, generateMoreCards, generateMoreQuestions, NOTE_DEPTHS, recordTopicRead, requestNote, streamDeepNote, useGlossary, useNodeCounts, useNotes, useSubjectCards, type GlossaryTerm, type NoteDepth } from '../../../../../features/learn/api';
import { ExplainSheet } from '../../../../../features/learn/ExplainSheet';
import { TermSheet } from '../../../../../features/learn/TermSheet';
import { createQuiz } from '../../../../../features/practice/api';
import { colorKeyFromHex, useSubject } from '../../../../../features/subjects/api';
import { useMastery, useNode, useOutline } from '../../../../../features/subjects/outline';
import { FlagSheet } from '../../../../../features/trust/FlagSheet';
import { openTutor } from '../../../../../features/tutor/open';
import { options, t } from '../../../../../i18n';
import { space, subjectColor, useTheme } from '../../../../../theme';
import { CapiCheer } from '../../../../../features/motivation/CapiCheer';
import { ReadAloudButton } from '../../../../../features/voice/VoiceButtons';
import { FindingsList, useTopicFindingCount } from '../../../../../features/material/FindingsList';
import { useClassSummary } from '../../../../../features/class/turma5';

type Tab = 'notes' | 'cards' | 'questions' | 'glossary';

/** S-MAT-09 {Tópico}: Resumo · Cartões · Questões · Glossário, ending in a retrieval prompt (LRN-01). */
export default function TopicScreen() {
  const { subjectId, nodeId } = useLocalSearchParams<{ subjectId: string; nodeId: string }>();
  const { node, data: outline } = useNode(subjectId, nodeId);
  const subject = useSubject(subjectId);
  const mastery = useMastery(subjectId);
  const [tab, setTab] = useState<Tab>('notes');
  const tabLabels = options('topic.tabs');
  const counts = useNodeCounts(nodeId);
  const overlay = useOverlay();
  const online = useOnline();
  const [busy, setBusy] = useState(false);

  const practice = async (count: number) => {
    setBusy(true);
    try {
      const res = await createQuiz({ kind: 'practice', scope: { subject_id: subjectId, node_ids: [nodeId] }, count, mode: 'practice' });
      router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch {
      overlay.snack(t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  const findingCount = useTopicFindingCount(nodeId);
  const classSummary = useClassSummary(nodeId, subject.data?.owner_class_group_id);
  const m = mastery.data?.get(nodeId)?.mastery;
  const unit = node?.parent_id ? outline?.byId.get(node.parent_id) : undefined;
  const firstSource = node?.sources[0];

  return (
    <Screen
      title=""
      actions={<IconButton icon="chatbubbles-outline" label={t('global.ask_tutor')} onPress={() => openTutor({ type: 'topic', subject_id: subjectId, node_id: nodeId })} />}
      footer={
        <ActionBar>
          <Button label={t('topic.practice')} icon="help-circle-outline" loading={busy} disabled={!online} disabledReason={t('offline.ai_disabled')} onPress={() => practice(10)} />
        </ActionBar>
      }
    >
      <LessonHeader
        title={node?.title ?? ''}
        trail={[subject.data?.name, unit?.title].filter(Boolean).join(' / ')}
        color={subject.data?.color}
        pages={firstSource ? pageLabel(firstSource.page_start, firstSource.page_end) : null}
        findings={findingCount}
        mastery={m}
      />
      <SegmentedControl<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'notes', label: tabLabels[0] ?? 'Resumo' },
          { value: 'cards', label: `${tabLabels[1] ?? 'Cartões'}${counts.data ? ` (${counts.data.cards})` : ''}` },
          { value: 'questions', label: `${tabLabels[2] ?? 'Questões'}${counts.data ? ` (${counts.data.questions})` : ''}` },
          { value: 'glossary', label: tabLabels[3] ?? 'Glossário' },
        ]}
      />
      {node?.excluded ? <Banner kind="neutral" message={`${t('outline.excluded')}.`} /> : null}
      {tab === 'notes' && node ? <NotesTab subjectId={subjectId} nodeId={nodeId} readyTopics={outline?.readyTopics ?? 0} totalTopics={outline?.topics.length ?? 0} keyTerms={node.key_terms} onRetrieval={() => practice(3)} busy={busy} /> : null}
      {tab === 'cards' ? <CardsTab subjectId={subjectId} nodeId={nodeId} shared={!!subject.data?.owner_class_group_id} /> : null}
      {tab === 'questions' ? (
        <View style={{ gap: space.md }}>
          {counts.data?.questions ? (
            <Card>
              <Text>{t('quiz.question_of', { i: counts.data.questions, n: counts.data.questions }).replace(/^Questão \d+ de /, '')} questões nesse tópico.</Text>
              <Button label={t('topic.practice')} loading={busy} onPress={() => practice(10)} />
            </Card>
          ) : (
            <EmptyState message={t('topic.no_questions')} />
          )}
          <Button
            variant="text"
            icon="sparkles-outline"
            label={t('topic.generate_more_questions')}
            disabled={!online}
            onPress={async () => {
              try {
                await generateMoreQuestions(nodeId);
                void counts.refetch();
              } catch {
                overlay.snack(t('error.generation'));
              }
            }}
          />
        </View>
      ) : null}
      {tab === 'glossary' ? <GlossaryTab subjectId={subjectId} nodeId={nodeId} /> : null}
      {node && tab === 'notes' ? (
        <Section title={t('topic.interactive')}>
          <Card>
            <ListItem icon="school-outline" title={t('lucas.title')} subtitle={t('lucas.entry_hint')} onPress={() => router.push({ pathname: '/lucas/[nodeId]', params: { nodeId, subjectId } })} />
            <ListItem icon="headset-outline" title={t('podcast.title')} subtitle={t('podcast.entry_hint')} onPress={() => router.push({ pathname: '/podcast/new', params: { subjectId, nodeIds: nodeId } })} />
            <ListItem icon="camera-outline" title={t('cam.title')} subtitle={t('cam.entry_hint')} onPress={() => router.push({ pathname: '/camera', params: { subjectId, nodeId } })} />
            <ListItem icon="git-network-outline" title={t('visual.open')} subtitle={t('visual.entry_hint')} onPress={() => router.push({ pathname: '/visual/[nodeId]', params: { nodeId, subjectId, title: node.title } })} />
            <ListItem icon="bulb-outline" title={t('mnemonic.create')} subtitle={t('mnemonic.entry_hint')} onPress={() => router.push({ pathname: '/mnemonic/new', params: { nodeId, title: node.title } })} />
          </Card>
        </Section>
      ) : null}
      {node && tab === 'notes' && classSummary.data ? (
        <Section title={t('divide.class_summary')}>
          <Card tone="soft">
            <RichContent variant="reading" text={classSummary.data.body} />
            {classSummary.data.credits.length ? (
              <Text variant="caption" tone="secondary">
                {t('divide.credits', { names: classSummary.data.credits.join(', ') })}
              </Text>
            ) : null}
            <AiBadge />
          </Card>
        </Section>
      ) : null}
      {node && tab === 'notes' && findingCount > 0 ? (
        <Section title={`⚠️ ${t('findings.title')}`}>
          <FindingsList nodeId={nodeId} subjectId={subjectId} onRedo={() => void requestNote(nodeId, 'study', true).then(() => overlay.snack(t('findings.redo_started'))).catch(() => overlay.snack(t('error.generation')))} />
        </Section>
      ) : null}
      {node && tab === 'notes' ? <TopicFacts objectives={node.learning_objectives} formulas={node.formulas} sources={node.sources} subjectId={subjectId} /> : null}
    </Screen>
  );
}

/** The lesson's title page: where it lives, its name set large, and how well you know it. */
function LessonHeader({ title, trail, color, pages, findings, mastery }: { title: string; trail: string; color?: string | null; pages: string | null; findings: number; mastery: number | null | undefined }) {
  const { colors: c, scheme } = useTheme();
  return (
    <View style={{ gap: space.sm, marginTop: -space.sm }}>
      {trail ? (
        <Row gap={space.sm}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: color ? subjectColor(colorKeyFromHex(color), scheme) : c.primary, transform: [{ rotate: '45deg' }] }} />
          <Text variant="label" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
            {trail}
          </Text>
        </Row>
      ) : null}
      <Text variant="display" accessibilityRole="header">
        {title}
      </Text>
      <Row gap={space.lg} wrap>
        {mastery != null ? (
          <Row gap={space.sm}>
            <PctRing value={mastery} size={34} label={`Domínio ${Math.round(mastery * 100)}%`} />
            <Text variant="bodySmall" tone="secondary">
              domínio
            </Text>
          </Row>
        ) : null}
        {pages ? (
          <Text variant="bodySmall" tone="secondary">
            {pages}
          </Text>
        ) : null}
        {findings > 0 ? (
          <Text variant="bodySmall" style={{ color: c.warning }} accessibilityLabel={t('findings.badge_a11y', { n: findings })}>
            {t('findings.badge_a11y', { n: findings })}
          </Text>
        ) : null}
      </Row>
    </View>
  );
}

/** Resumo rápido · Resumo · Aprofundado as words you mark with the highlighter. */
function DepthPicker({ value, onChange, labels }: { value: NoteDepth; onChange: (d: NoteDepth) => void; labels: string[] }) {
  const { colors: c } = useTheme();
  return (
    <Row gap={space.xs} wrap style={{ marginTop: space.xs }}>
      {NOTE_DEPTHS.map((d, i) => {
        const selected = d === value;
        return (
          <Pressable
            key={d}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(d)}
            hitSlop={6}
            style={({ pressed }) => ({ paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: 4, backgroundColor: selected ? c.highlight : pressed ? c.surface2 : 'transparent' })}
          >
            <Text variant="label" weight={selected ? 'bold' : undefined} style={{ color: selected ? c.textPrimary : c.textSecondary }}>
              {labels[i] ?? d}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

function TopicFacts({ objectives, formulas, sources, subjectId }: { objectives: string[]; formulas: { latex?: string; label?: string; name?: string }[]; sources: { document_id: string; page_start: number; page_end?: number | null }[]; subjectId: string }) {
  return (
    <View style={{ gap: space.md }}>
      {objectives.length ? (
        <Card>
          <Text variant="label">{t('topic.objectives')}</Text>
          {objectives.map((o) => (
            <Text key={o} variant="bodySmall">
              • {o}
            </Text>
          ))}
        </Card>
      ) : null}
      {formulas.length ? (
        <Card>
          <Text variant="label">{t('topic.formulas')}</Text>
          {formulas.map((f, i) => (
            <RichContent key={i} text={`${f.label ?? f.name ?? ''}${f.latex ? ` $${f.latex}$` : ''}`} />
          ))}
        </Card>
      ) : null}
      {sources.length ? (
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('topic.sources')}</Text>
          <PageChips sources={sources} subjectId={subjectId} max={6} />
        </View>
      ) : null}
    </View>
  );
}

function NotesTab({ subjectId, nodeId, readyTopics, totalTopics, keyTerms, onRetrieval, busy }: { subjectId: string; nodeId: string; readyTopics: number; totalTopics: number; keyTerms: string[]; onRetrieval: () => void; busy: boolean }) {
  const notes = useNotes(nodeId);
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const [depth, setDepth] = useState<NoteDepth>('study');
  const [explain, setExplain] = useState(false);
  const [flag, setFlag] = useState(false);
  const [term, setTerm] = useState<string | null>(null);
  const [deep, setDeep] = useState<{ text: string; streaming: boolean } | null>(null);
  const depthLabels = options('notes.depths');
  const opened = useRef(Date.now());
  const note = notes.data?.find((n) => n.depth === depth && n.status === 'ready');
  const pending = notes.data?.find((n) => n.depth === depth && n.status !== 'ready');
  const glossary = useGlossary(subjectId);

  // A topic that isn't ready is moved up the generation queue when opened (ING-03.13).
  useEffect(() => {
    if (notes.isFetched && !notes.data?.some((n) => n.depth === 'study') && online) void requestNote(nodeId, 'study').catch(() => undefined);
  }, [notes.isFetched, notes.data, nodeId, online]);

  useEffect(
    () => () => {
      const secs = Math.round((Date.now() - opened.current) / 1000);
      if (userId && secs >= 10) void recordTopicRead(userId, nodeId, depth, secs).catch(() => undefined);
    },
    [userId, nodeId, depth],
  );

  const termRow = useMemo(() => glossary.data?.find((g) => g.term.toLowerCase() === term?.toLowerCase() || g.aliases.some((a) => a.toLowerCase() === term?.toLowerCase())), [glossary.data, term]);

  const startDeep = () => {
    setDeep({ text: '', streaming: true });
    streamDeepNote(nodeId, {
      onDelta: (d) => setDeep((x) => ({ text: (x?.text ?? '') + d, streaming: true })),
      onDone: () => {
        setDeep((x) => (x ? { ...x, streaming: false } : x));
        void notes.refetch();
      },
      onError: (e) => {
        setDeep(null);
        overlay.snack(e.code === 'budget_exhausted' ? t('budget.user_daily') : t('error.generation'));
      },
    });
  };

  return (
    <View style={{ gap: space.md }}>
      <DepthPicker value={depth} onChange={setDepth} labels={depthLabels} />
      {notes.isLoading ? (
        <View style={{ gap: space.sm }}>
          <Skeleton height={20} />
          <Skeleton height={16} />
          <Skeleton height={16} width="80%" />
        </View>
      ) : note ? (
        <View style={{ gap: space.md }}>
          {note.low_citation_coverage ? <Banner kind="neutral" message="Tem pouco conteúdo sobre isso no seu material." /> : null}
          <MarkdownView markdown={note.body} terms={keyTerms} onTerm={setTerm} onCitation={(i) => {
            const c = note.citations[i];
            if (c) router.push({ pathname: '/subjects/[subjectId]/document/[documentId]', params: { subjectId, documentId: c.document_id, page: String(c.page_start), ...(c.cited_text ? { cite: c.cited_text.slice(0, 300) } : {}) } });
          }} />
          <View style={{ gap: space.xs }}>
            <PageChips sources={note.citations} subjectId={subjectId} max={4} />
            <Row wrap>
              <AiBadge />
              <View style={{ flex: 1 }} />
              <ReadAloudButton id={`note:${note.id}`} text={note.body} />
              <Button compact variant="text" label={t('global.report_error')} onPress={() => setFlag(true)} />
            </Row>
          </View>
          <Button variant="secondary" icon="bulb-outline" label={t('notes.explain')} disabled={!online} onPress={() => setExplain(true)} />
          <Card tone="soft" style={{ marginTop: space.md }}>
            <Row gap={space.md}>
              <Text variant="title" style={{ flex: 1 }}>
                {t('notes.retrieval')}
              </Text>
              <CapiCheer happy={false} size={84} />
            </Row>
            <Button label={t('notes.retrieval_cta')} icon="flash-outline" loading={busy} disabled={!online} onPress={onRetrieval} />
          </Card>
          <FlagSheet visible={flag} onClose={() => setFlag(false)} itemType="note" itemId={note.id} shared={false} />
          <ExplainSheet visible={explain} onClose={() => setExplain(false)} target={{ target_type: 'concept', target_id: nodeId }} subjectId={subjectId} />
        </View>
      ) : depth === 'deep' ? (
        deep ? (
          <View style={{ gap: space.sm }}>
            <RichContent variant="reading" text={deep.text || t('tutor.thinking')} />
            {deep.streaming ? <Text tone="secondary">Gerando… leva uns 30 segundos</Text> : <AiBadge />}
          </View>
        ) : (
          <Button variant="tonal" icon="sparkles-outline" label="Gerar versão aprofundada" disabled={!online} disabledReason={t('offline.ai_disabled')} onPress={startDeep} />
        )
      ) : (
        <Banner kind="info" icon="hourglass-outline" message={pending?.status === 'failed' ? t('error.generation') : t('notes.not_ready', { done: readyTopics, total: totalTopics })} action={pending?.status === 'failed' ? { label: t('global.retry'), onPress: () => void requestNote(nodeId, depth, true).then(() => notes.refetch()) } : undefined} />
      )}
      <TermSheet term={termRow ?? null} visible={!!term} onClose={() => setTerm(null)} subjectId={subjectId} nodeId={nodeId} />
    </View>
  );
}

function CardsTab({ subjectId, nodeId, shared }: { subjectId: string; nodeId: string; shared: boolean }) {
  const cards = useSubjectCards(subjectId);
  const online = useOnline();
  const overlay = useOverlay();
  const list = (cards.data ?? []).filter((c) => c.node_id === nodeId);
  return (
    <View style={{ gap: space.sm }}>
      {cards.isLoading ? <Skeleton height={80} /> : null}
      {cards.isFetched && !list.length ? <EmptyState message={t('topic.no_cards')} /> : null}
      {list.map((c) => (
        <Card key={c.id} onPress={() => router.push({ pathname: '/subjects/[subjectId]/card/[cardId]', params: { subjectId, cardId: c.id } })}>
          <RichContent text={c.front} />
          <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
            {c.back}
          </Text>
        </Card>
      ))}
      <Row wrap>
        <Button compact variant="tonal" icon="add" label={t('topic.new_card')} onPress={() => router.push({ pathname: '/subjects/[subjectId]/card/[cardId]', params: { subjectId, cardId: 'new', nodeId, shared: shared ? '1' : '' } })} />
        <Button compact variant="tonal" icon="image-outline" label={t('occlusion.new')} onPress={() => router.push({ pathname: '/occlusion/new', params: { subjectId, nodeId } })} />
        <Button
          compact
          variant="text"
          icon="sparkles-outline"
          label={t('topic.generate_more_cards')}
          disabled={!online}
          onPress={async () => {
            try {
              await generateMoreCards(nodeId);
              void cards.refetch();
            } catch {
              overlay.snack(t('error.generation'));
            }
          }}
        />
      </Row>
    </View>
  );
}

function GlossaryTab({ subjectId, nodeId }: { subjectId: string; nodeId: string }) {
  const glossary = useGlossary(subjectId);
  const [term, setTerm] = useState<GlossaryTerm | null>(null);
  const list = (glossary.data ?? []).filter((g) => g.node_id === nodeId);
  if (glossary.isFetched && !list.length) return <EmptyState message={t('glossary.empty')} />;
  return (
    <View>
      {list.map((g) => (
        <ListItem key={g.id} title={g.term} subtitle={g.definition} onPress={() => setTerm(g)} />
      ))}
      <TermSheet term={term} visible={!!term} onClose={() => setTerm(null)} subjectId={subjectId} nodeId={nodeId} />
    </View>
  );
}
