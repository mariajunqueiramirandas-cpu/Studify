import { and, eq, isNull } from 'drizzle-orm';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, FlatList, View } from 'react-native';
import { uuidv7 } from 'uuidv7';
import type { Grade } from 'ts-fsrs';
import { ActionBar, Banner, Button, Card, Flashcard, Options, PageChips, ProgressBar, RatingBar, RichContent, RichText, Screen, Text, useOnline } from '../components';
import { useDb } from '../db/DatabaseProvider';
import { recordReview } from '../db/hooks/review';
import { enqueueOutbox } from '../db/outbox';
import { feedItems } from '../db/schema';
import { useSession } from '../features/auth/session';
import { studyDateOf } from '../lib/dates';
import { getKv } from '../lib/kv';
import { buildLocalQueue, type ReviewCard } from '../features/memory/local';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';

type Item =
  | { kind: 'card'; id: string; card: ReviewCard }
  | { kind: 'feed'; id: string; type: string; subjectId: string; nodeId: string | null; content: FeedContent; sourcePages: { document_id: string; page_start: number; page_end: number }[]; external: boolean };

interface FeedContent {
  title?: string;
  body?: string;
  formula_latex?: string | null;
  caption?: string | null;
  question?: { stem: string; options: { id: string; text: string; rationale: string }[]; correct: string } | null;
}

const SESSION_MIN = 10; // D-22
const DAILY_SOFT_LIMIT_MIN = 45;
const BEDTIME_HOUR = 23;
const MAX_EXTENSIONS = 3;

/** Interleave due cards with feed items in rounds of 5 (FED-01; learning-engine §10, simplified offline). */
function buildRounds(cards: ReviewCard[], items: Item[]): Item[] {
  const out: Item[] = [];
  const cs = cards.map<Item>((c) => ({ kind: 'card', id: `c-${c.id}`, card: c }));
  const lessons = items.filter((i) => i.kind === 'feed' && i.type !== 'quick_question');
  const questions = items.filter((i) => i.kind === 'feed' && i.type === 'quick_question');
  while (cs.length || lessons.length || questions.length) {
    const round = [cs.shift(), lessons.shift(), questions.shift(), cs.shift(), lessons.shift() ?? questions.shift()].filter((x): x is Item => !!x);
    out.push(...round);
  }
  return out;
}

/** S-PRA-15 Feed + S-PRA-16 Checkpoint (FED-01) — finite sessions, gentle stop (SP-06, ux §12). */
export default function Feed() {
  const db = useDb();
  const { userId } = useSession();
  const online = useOnline();
  const { colors } = useTheme();
  const height = Dimensions.get('window').height - 180;
  const sessionId = useRef(uuidv7());
  const startedAt = useRef(Date.now());
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [stats, setStats] = useState({ cards: 0, k: 0, n: 0, lessons: 0 });
  const [checkpoint, setCheckpoint] = useState(false);
  const [extensions, setExtensions] = useState(0);
  const [goalMin, setGoalMin] = useState(SESSION_MIN);
  const [now, setNow] = useState(Date.now());
  const kvKey = `feed_minutes_${studyDateOf(Date.now())}`;
  const todayBefore = useRef(getKv().getNumber(kvKey) ?? 0);

  const items = useMemo(() => {
    const cards = buildLocalQueue(db, { limit: 40 });
    const rows = db
      .select()
      .from(feedItems)
      .where(and(eq(feedItems.status, 'active'), isNull(feedItems.deletedAt)))
      .limit(60)
      .all()
      .filter((r) => !r.personalForUserId || r.personalForUserId === userId)
      .map<Item>((r) => ({ kind: 'feed', id: r.id, type: r.type, subjectId: r.subjectId, nodeId: r.nodeId ?? null, content: r.content as FeedContent, sourcePages: (r.sourcePages ?? []) as never, external: !!r.externalKnowledge }));
    return buildRounds(cards, rows);
  }, [db, userId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const minutes = (now - startedAt.current) / 60000;
  useEffect(() => {
    if (minutes >= goalMin && !checkpoint) setCheckpoint(true);
  }, [minutes, goalMin, checkpoint]);

  const impression = (item: Item, action: 'answered' | 'rated' | 'read') => {
    void enqueueOutbox(db, {
      kind: 'feed_impression',
      payload: { id: uuidv7(), user_id: userId, feed_item_id: item.kind === 'feed' ? item.id : null, item_kind: item.kind === 'card' ? 'card' : 'feed_item', item_ref_id: item.kind === 'card' ? item.card.id : item.id, session_id: sessionId.current, shown_at: new Date().toISOString(), action },
    });
  };

  const exit = () => {
    getKv().set(kvKey, todayBefore.current + minutes);
    router.back();
  };

  if (!items.length) {
    return (
      <Screen title={t('feed.title')} immersive>
        <Banner kind="success" message={t('feed.empty')} />
      </Screen>
    );
  }

  if (checkpoint) {
    const breakTime = extensions >= MAX_EXTENSIONS;
    return (
      <Screen
        title={t('feed.title')}
        immersive
        onBack={exit}
        footer={
          <ActionBar>
            <Button label={t('feed.stop')} onPress={exit} />
            <Button
              variant="secondary"
              label={breakTime ? 'Continuar mesmo assim' : t('feed.more')}
              onPress={() => {
                setExtensions((e) => e + 1);
                setGoalMin((g) => g + 5);
                setCheckpoint(false);
              }}
            />
          </ActionBar>
        }
      >
        <RichText variant="title">{t('feed.checkpoint', { c: stats.cards, k: stats.k, n: stats.n, l: stats.lessons, min: Math.round(minutes) })}</RichText>
        {breakTime ? <Banner kind="info" message={t('feed.break')} /> : null}
        {todayBefore.current + minutes >= DAILY_SOFT_LIMIT_MIN ? <Banner kind="info" message={t('feed.daily_limit')} /> : null}
        {new Date().getHours() >= BEDTIME_HOUR ? <Banner kind="info" icon="moon-outline" message={t('feed.bedtime')} /> : null}
      </Screen>
    );
  }

  return (
    <Screen title={t('feed.title')} immersive scroll={false} padded={false} onBack={exit}>
      {!online ? <Text variant="bodySmall" tone="secondary" align="center">{t('feed.offline')}</Text> : null}
      <View style={{ paddingHorizontal: space.lg }}>
        <ProgressBar value={Math.min(1, minutes / goalMin)} height={4} />
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={height}
        decelerationRate="fast"
        getItemLayout={(_, i) => ({ length: height, offset: height * i, index: i })}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.y / height))}
        ListHeaderComponent={index === 0 ? <Text variant="bodySmall" tone="secondary" align="center">{t('feed.swipe_hint')}</Text> : undefined}
        renderItem={({ item }) => (
          <View style={{ height, padding: space.lg, justifyContent: 'center' }}>
            {item.kind === 'card' ? (
              <View style={{ flex: 1, gap: space.md }}>
                <Flashcard front={item.card.front} back={item.card.back} type={item.card.type} clozeIndex={item.card.clozeIndex} flipped={!!flipped[item.id]} onFlip={() => setFlipped((f) => ({ ...f, [item.id]: true }))} tags={[flipped[item.id] ? t('feed.card.swipe') : t('feed.card.tap')]} />
                {flipped[item.id] && !answers[item.id] ? (
                  <RatingBar
                    twoButton
                    onRate={async (r) => {
                      // Each Feed rating is a real FSRS review (Errei = Again, Lembrei = Good).
                      await recordReview(db, { cardId: item.card.id, rating: (r === 1 ? 1 : 3) as Grade, source: 'feed' }).catch(() => undefined);
                      setAnswers((a) => ({ ...a, [item.id]: String(r) }));
                      setStats((s) => ({ ...s, cards: s.cards + 1 }));
                      impression(item, 'rated');
                    }}
                  />
                ) : null}
              </View>
            ) : (
              <Card style={{ borderLeftWidth: 4, borderLeftColor: colors.primary, borderRadius: radius.xl }}>
                <Text variant="label" tone="accent">
                  {item.type === 'did_you_know' ? t('feed.did_you_know') : item.type === 'quick_question' ? t('feed.quick_question') : item.type === 'diagram' ? t('feed.diagram') : t('feed.micro_lesson')}
                </Text>
                {item.content.title ? <Text variant="title">{item.content.title}</Text> : null}
                {item.content.body ? <RichContent text={item.content.body} variant="cardFace" /> : null}
                {item.content.formula_latex ? <RichContent text={`$$${item.content.formula_latex}$$`} /> : null}
                {item.content.question ? (
                  <View style={{ gap: space.sm }}>
                    <RichContent variant="reading" text={item.content.question.stem} />
                    <Options
                      options={item.content.question.options}
                      selected={answers[item.id] ? [answers[item.id]!] : []}
                      correct={answers[item.id] ? [item.content.question.correct] : undefined}
                      disabled={!!answers[item.id]}
                      onSelect={(id) => {
                        const ok = id === item.content.question!.correct;
                        setAnswers((a) => ({ ...a, [item.id]: id }));
                        setStats((s) => ({ ...s, n: s.n + 1, k: s.k + (ok ? 1 : 0) }));
                        impression(item, 'answered');
                      }}
                    />
                    {answers[item.id] ? (
                      <RichText>{answers[item.id] === item.content.question.correct ? t('quiz.correct') : t('quiz.wrong', { letter: item.content.question.correct })}</RichText>
                    ) : null}
                  </View>
                ) : null}
                {/* LRN-05.5: a diagram card from an auto visual opens the native drawing. */}
                {item.type === 'diagram' && item.nodeId && (item.content as { visual_id?: string }).visual_id ? (
                  <Button compact variant="tonal" icon="git-network-outline" label={t('visual.feed_open')} onPress={() => router.push({ pathname: '/visual/[nodeId]', params: { nodeId: item.nodeId!, subjectId: item.subjectId } })} />
                ) : null}
                {item.external ? <Text variant="bodySmall" tone="info">Curiosidade além do material</Text> : null}
                <PageChips sources={item.sourcePages} subjectId={item.subjectId} />
                {item.type !== 'quick_question' && !answers[item.id] ? (
                  <Button
                    compact
                    variant="text"
                    label={t('global.done')}
                    onPress={() => {
                      setAnswers((a) => ({ ...a, [item.id]: 'read' }));
                      setStats((s) => ({ ...s, lessons: s.lessons + 1 }));
                      impression(item, 'read');
                    }}
                  />
                ) : null}
              </Card>
            )}
          </View>
        )}
      />
    </Screen>
  );
}
