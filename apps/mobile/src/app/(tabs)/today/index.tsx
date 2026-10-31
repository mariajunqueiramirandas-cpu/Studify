import { Ionicons } from '@expo/vector-icons';
import { energyBucketOf, orderByEnergy } from '@studify/shared';
import { router } from 'expo-router';
import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  Banner,
  Button,
  Capi,
  Card,
  IconButton,
  IconTile,
  ProgressRing,
  RichText,
  Row,
  Screen,
  Section,
  Tactile,
  Text,
  useOverlay,
  type IconName,
  type IconTone,
} from '../../../components';
import { useDb } from '../../../db/DatabaseProvider';
import { useLive } from '../../../db/hooks';
import { useSession } from '../../../features/auth/session';
import { countdown, daysBetween, greeting, longDate, parseDate, weekdayLong } from '../../../features/common/format';
import { updatePlanItem, useGoalExams, useGoals, usePlanCoach, useUpcomingExams, type Exam } from '../../../features/goals/api';
import { CoachCard } from '../../../features/goals/CoachCard';
import { enemRoute } from '../../../features/enem/format';
import { useTodayPlan, type TodayItem } from '../../../features/goals/today';
import { dueCount } from '../../../features/memory/local';
import { useMotivation } from '../../../features/motivation/api';
import { InboxBell } from '../../../features/notifications/InboxBell';
import { useCapi } from '../../../features/motivation/capi';
import { isDemandingUnit, usePerformanceWindows } from '../../../features/energy/api';
import { useUnseenRetrospective } from '../../../features/retro/api';
import { WeeklyCheckin } from '../../../features/wellbeing/WeeklyCheckin';
import { WellbeingNudge } from '../../../features/wellbeing/WellbeingNudge';
import { useFocusStore } from '../../../stores/focus';
import { colorKeyFromHex, useSubjects } from '../../../features/subjects/api';
import { options, t } from '../../../i18n';
import { cheer } from '../../../lib/haptics';
import { FONTS, radius, shade, space, subjectColor, useTheme } from '../../../theme';

/** S-HOJE-01 Hoje (GOL-05): plan, countdowns, ≤ 3 cards, "Começar sessão". */
export default function Today() {
  const { profile } = useSession();
  const db = useDb();
  const plan = useTodayPlan();
  const goals = useGoals();
  const exams = useUpcomingExams();
  const coach = usePlanCoach();
  const pastExams = useGoalExams(goals.data?.[0]?.id);
  const subjects = useSubjects();
  const motivation = useMotivation();
  const capi = useCapi();
  const focusRunning = useFocusStore((st) => st.run !== null);
  const retro = useUnseenRetrospective();
  const energy = usePerformanceWindows();
  const overlay = useOverlay();
  const { colors, scheme } = useTheme();
  const due = useLive((d) => dueCount(d), { tables: ['card_states', 'cards'] });
  const dueN = due.data ?? 0;
  const activeGoal = goals.data?.[0];
  const subjectName = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.id, s.name])), [subjects.data]);
  const subjectTint = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.id, subjectColor(colorKeyFromHex(s.color), scheme)])), [subjects.data, scheme]);
  const upcoming = (exams.data ?? []).slice(0, 4);
  const pending = plan.items.filter((i) => i.status === 'planned');
  // GOL-10.2: inside one of the student's best windows, demanding items go first.
  const best = energy.data?.best;
  const { items: orderedItems, inGoodWindow } = useMemo(() => {
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    const good = best ?? [];
    const withDemand = plan.items.map((i) => ({ ...i, demanding: isDemandingUnit(i.unitType) }));
    return { items: orderByEnergy(withDemand, minute, good), inGoodWindow: good.includes(energyBucketOf(minute)) };
  }, [plan.items, best]);
  const hasSubjects = (subjects.data ?? []).length > 0;

  // At most 3 cards (ux §4.2): véspera, desespero offer, grade ask, upload.
  const cards = useMemo(() => {
    const out: { key: string; node: React.ReactNode }[] = [];
    const now = new Date();
    const tomorrow = (exams.data ?? []).filter((e) => daysBetween(now, parseDate(e.local_date)) === 1);
    if (tomorrow[0] && now.getHours() >= 15) {
      out.push({
        key: 'vespera',
        node: (
          <OfferCard
            key="vespera"
            icon="moon-outline"
            tone="lagoon"
            title={t('vespera.title')}
            body={t('vespera.notify', { subject: subjectName.get(tomorrow[0]!.subject_id ?? '') ?? tomorrow[0]!.title, minutes: 25 })}
            onPress={() => router.push({ pathname: '/goal/[goalId]/eve/[examId]', params: { goalId: tomorrow[0]!.goal_id, examId: tomorrow[0]!.id } })}
          />
        ),
      });
    }
    const soon = (exams.data ?? []).find((e) => {
      const d = daysBetween(now, parseDate(e.local_date));
      return d >= 1 && d <= 6;
    });
    if (soon && activeGoal && !activeGoal.settings?.desperate_offer_dismissed) {
      out.push({
        key: 'desperate',
        node: (
          <OfferCard
            key="desperate"
            icon="flash-outline"
            tone="lamp"
            title={t('desperate.offer.title', { n: daysBetween(now, parseDate(soon.local_date)) })}
            body={t('desperate.offer.body')}
            onPress={() => router.push({ pathname: '/goal/[goalId]/desperate', params: { goalId: activeGoal.id } })}
          />
        ),
      });
    }
    // Exam day: only "Boa prova! 🍀" in the morning, no study content (GOL-07.7).
    const todayExam = (exams.data ?? []).find((e) => daysBetween(now, parseDate(e.local_date)) === 0);
    if (todayExam && now.getHours() < 12) {
      out.unshift({
        key: 'luck',
        node: (
          <Card key="luck" tone="soft">
            <Text variant="title" align="center">
              {t('exam.good_luck')}
            </Text>
          </Card>
        ),
      });
    }
    // GOL-02.4: ask for the grade once after the test date (the exam's status turns "done" when logged).
    const ungraded = (pastExams.data ?? []).find((e) => e.grade == null && e.status !== 'cancelled' && daysBetween(parseDate(e.local_date), now) >= 1);
    if (ungraded) {
      out.push({
        key: 'grade',
        node: (
          <OfferCard
            key="grade"
            icon="ribbon-outline"
            title={t('grade.ask', { subject: subjectName.get(ungraded.subject_id ?? '') ?? ungraded.title })}
            action={t('exam.log_grade')}
            onPress={() => router.push({ pathname: '/goal/[goalId]/exam/[examId]', params: { goalId: ungraded.goal_id, examId: ungraded.id } })}
          />
        ),
      });
    }
    if (!hasSubjects) {
      out.push({
        key: 'upload',
        node: (
          <OfferCard key="upload" icon="cloud-upload-outline" title={t('upload.button')} body={t('today.upload_cta')} onPress={() => router.push('/subjects/new')} />
        ),
      });
    }
    return out.slice(0, 3);
  }, [exams.data, pastExams.data, activeGoal, hasSubjects, subjectName]);

  const today = new Date();
  const weekday = weekdayLong(today);
  const dateLine = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${longDate(today)}`;

  // With nothing planned but cards due, the session would be a single review step: go straight to the cards.
  const reviewsOnly = pending.length === 0 && dueN > 0;
  const startSession = (minutes?: number) =>
    reviewsOnly
      ? router.push({ pathname: '/review', params: { source: 'session' } })
      : router.push({ pathname: '/session/[sessionId]', params: { sessionId: 'new', ...(minutes ? { minutes: String(minutes) } : {}) } });

  const toggleItem = async (item: TodayItem, status: 'done' | 'skipped') => {
    try {
      await updatePlanItem(item.id, { status });
      overlay.undo(status === 'done' ? t('today.item_done') : t('today.item_skipped'), () => void updatePlanItem(item.id, { status: 'planned' }));
    } catch {
      overlay.snack(t('offline.queued'));
    }
  };

  const quickStart = pending.length > 0 || dueN > 0;
  const planLine = plan.items.length ? t('today.summary', { minutes: plan.minutes, subjects: plan.subjects }) : dueN ? t('today.nothing_planned') : t('today.all_clear');

  return (
    <Screen
      root
      title=""
      eyebrow={dateLine}
      actions={
        <>
          <IconButton icon="timer-outline" label={t('focus.title')} onPress={() => router.push('/focus')} />
          <IconButton icon="camera-outline" label={t('cam.title')} onPress={() => router.push('/camera')} />
          <InboxBell />
        </>
      }
    >
      {/* The day's mission: who, how far along, and the one big key that starts it. No sticky footer: the start
          lives here, and the quick-time keys start a shorter session in one tap. */}
      <View style={[styles.hero, { backgroundColor: colors.hero }]}>
        <View style={[styles.moon, { backgroundColor: colors.heroKey }]} pointerEvents="none" />
        <View style={[styles.moonSmall, { backgroundColor: colors.heroKey }]} pointerEvents="none" />
        <View style={styles.heroTop}>
          <View style={{ flex: 1, gap: space.xs }}>
            <Text variant="display" accessibilityRole="header" style={{ color: colors.onHero }}>
              {greeting(profile?.display_name ?? '')}
            </Text>
            <Text variant="bodySmall" style={{ color: colors.heroMuted }}>
              {planLine}
            </Text>
          </View>
          {capi.visible ? (
            <Pressable onPress={() => router.push('/profile/capi')} accessibilityRole="button" accessibilityLabel={t('capi.title')} style={styles.capi}>
              <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={104} />
            </Pressable>
          ) : null}
        </View>
        {motivation.data ? (
          // The ring and streak open Progresso.
          <Pressable onPress={() => router.push('/profile/progress')} accessibilityRole="button" accessibilityLabel={t('progress.title')} style={styles.goal}>
            <ProgressRing
              value={Math.min(1, motivation.data.todayMinutes / motivation.data.dailyGoal)}
              size={48}
              stroke={6}
              color={colors.lamp}
              trackColor={colors.heroKey}
              label={t('goal_daily.label', { n: motivation.data.dailyGoal })}
            >
              <Text variant="label" weight="bold" style={{ fontSize: 14, lineHeight: 17, color: colors.onHero }}>
                {Math.min(999, Math.round(motivation.data.todayMinutes))}
              </Text>
            </ProgressRing>
            <View style={{ flexShrink: 1, gap: 2 }}>
              <Text variant="label" style={{ color: colors.onHero }}>
                {motivation.data.todayMinutes >= motivation.data.dailyGoal ? t('goal_daily.done') : t('goal_daily.label', { n: motivation.data.dailyGoal })}
              </Text>
              {motivation.data.streak > 0 ? (
                <Text variant="bodySmall" style={{ color: colors.heroMuted }}>
                  {t('streak.count', { n: motivation.data.streak })}
                </Text>
              ) : null}
            </View>
          </Pressable>
        ) : null}
        <Button variant="lamp" label={reviewsOnly ? t('today.start_review', { count: dueN }) : quickStart ? t('today.start') : t('review.all_done')} icon={quickStart ? 'play' : undefined} onPress={() => startSession()} disabled={!quickStart} />
        {quickStart && !reviewsOnly ? (
          <View style={styles.quick}>
            <Ionicons name="hourglass-outline" size={16} color={colors.heroMuted} />
            <Text variant="bodySmall" style={{ color: colors.heroMuted, flex: 1 }} numberOfLines={1}>
              {t('today.quick_short')}
            </Text>
            {[10, 20, 30].map((n) => (
              <Tactile
                key={n}
                onPress={() => startSession(n)}
                accessibilityLabel={t('today.quick', { n })}
                color={colors.heroKey}
                ledge={shade(colors.hero, 0.4)}
                radius={radius.md}
                depth={3}
                style={styles.quickKey}
              >
                <Text variant="label" weight="bold" style={{ color: colors.onHero }}>
                  {n} min
                </Text>
              </Tactile>
            ))}
          </View>
        ) : null}
      </View>
      {focusRunning ? <Banner kind="info" icon="timer-outline" message={t('focus.running_banner')} action={{ label: t('focus.open'), onPress: () => router.push('/focus') }} /> : null}
      {retro ? (
        <Banner kind="success" icon="sparkles-outline" title={t('retro.ready')} message={retro.title} action={{ label: t('retro.open'), onPress: () => router.push({ pathname: '/retro/[retroId]', params: { retroId: retro.id } }) }} />
      ) : null}
      <WellbeingNudge surface="today" />
      <WeeklyCheckin />
      {motivation.data?.streakResetNotice ? <Banner kind="neutral" message={t('streak.reset', { n: motivation.data.bestStreak })} /> : null}
      {upcoming.length ? (
        // A pad of tear-off calendar pages, one per test.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.exams}>
          {upcoming.map((e: Exam) => (
            <CalendarPage
              key={e.id}
              exam={e}
              name={subjectName.get(e.subject_id ?? '') ?? e.title}
              tint={subjectTint.get(e.subject_id ?? '') ?? colors.primary}
              onPress={() => router.push({ pathname: '/goal/[goalId]/exam/[examId]', params: { goalId: e.goal_id, examId: e.id } })}
            />
          ))}
        </ScrollView>
      ) : null}

      {cards.map((c) => c.node)}

      {/* The coach's day counts go stale: show it only when it was written today or yesterday (GOL-04.10). */}
      {activeGoal && coach.data && daysBetween(parseDate(coach.data.localDate), parseDate(plan.day)) <= 1 ? <CoachCard coach={coach.data} /> : null}

      {/* Without a test the plan still works toward mastery, so the day's trail shows whenever there is one. */}
      {activeGoal || plan.items.length > 0 ? (
        <Section title={t('today.plan_title')} action={activeGoal ? <Button compact variant="text" label={t('dashboard.title')} onPress={() => router.push(`/goal/${activeGoal.id}`)} /> : undefined}>
          {inGoodWindow && pending.some((i) => isDemandingUnit(i.unitType)) ? (
            <Text variant="bodySmall" tone="accent">
              {t('energy.good_now')}
            </Text>
          ) : null}
          {/* The day as a trail: due reviews come first (ux §1), then each stop of the plan, joined by a path. */}
          <View>
            {dueN > 0 ? <ReviewStop due={dueN} last={!orderedItems.length} /> : null}
            {orderedItems.map((item, i) => (
              <PlanRow
                key={item.id}
                item={item}
                last={i === orderedItems.length - 1}
                color={item.subjectColor ? subjectColor(colorKeyFromHex(item.subjectColor), scheme) : colors.primary}
                onDone={() => toggleItem(item, 'done')}
                onSkip={() => toggleItem(item, 'skipped')}
              />
            ))}
          </View>
          {plan.items.length === 0 && !dueN ? <Text tone="secondary">{t('today.all_clear')}</Text> : null}
        </Section>
      ) : null}
      {activeGoal ? null : <OfferCard icon="calendar-outline" title={t('today.no_goal')} action={t('today.create_goal')} onPress={() => router.push('/goal/new')} />}
      {void db}
    </Screen>
  );
}

/** Plan unit types as the student reads them, each with its own icon. */
const UNITS: Record<string, { key: string; icon: IconName }> = {
  learn: { key: 'learn', icon: 'book-outline' },
  learn_light: { key: 'learn', icon: 'book-outline' },
  practice: { key: 'practice', icon: 'help-circle-outline' },
  mock: { key: 'mock', icon: 'timer-outline' },
  review: { key: 'review', icon: 'albums-outline' },
  warmup: { key: 'review', icon: 'albums-outline' },
  vespera: { key: 'vespera', icon: 'moon-outline' },
  upload_material: { key: 'upload', icon: 'cloud-upload-outline' },
  essay: { key: 'essay', icon: 'create-outline' },
};

/** A Hoje suggestion (véspera, desespero, grade, upload): icon key, a line or two, and where it leads. */
function OfferCard({ icon, tone = 'primary', title, body, action, onPress }: { icon: IconName; tone?: IconTone; title: string; body?: string; action?: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Card onPress={onPress} accessibilityLabel={body ? `${title}. ${body}` : title}>
      <Row gap={space.md} style={{ alignItems: 'flex-start' }}>
        <IconTile icon={icon} tone={tone} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" weight="bold">
            {title}
          </Text>
          {body ? (
            <Text variant="bodySmall" tone="secondary" numberOfLines={3}>
              {body}
            </Text>
          ) : null}
          {action ? (
            <Text variant="label" tone="accent">
              {action}
            </Text>
          ) : null}
        </View>
        <Ionicons name="arrow-forward" size={20} color={colors.primary} style={{ marginTop: 2 }} />
      </Row>
    </Card>
  );
}

/** A test as a tear-off calendar page: weekday on a band in the subject's colour, the day big, the countdown under it. */
function CalendarPage({ exam, name, tint, onPress }: { exam: Exam; name: string; tint: string; onPress: () => void }) {
  const { colors, easyReading } = useTheme();
  const date = parseDate(exam.starts_at ?? exam.local_date);
  const urgent = daysBetween(new Date(), date) <= 1;
  const text = countdown(exam.starts_at ?? exam.local_date, !!exam.starts_at);
  return (
    <Tactile
      onPress={onPress}
      accessibilityLabel={`${name}. ${text}`}
      color={colors.surface1}
      borderColor={colors.border}
      ledge={shade(colors.border, 0.14)}
      borderWidth={1.5}
      radius={radius.lg}
      depth={3}
      style={styles.page}
      pressedStyle={{ backgroundColor: colors.surface2 }}
    >
      <View style={[styles.pageBand, { backgroundColor: tint }]}>
        {/* The pad's binding holes. */}
        <View style={styles.holes}>
          {[0, 1].map((i) => (
            <View key={i} style={[styles.hole, { backgroundColor: colors.surface1 }]} />
          ))}
        </View>
        <Text variant="bodySmall" weight="bold" style={{ color: colors.onPrimary, letterSpacing: 1 }} numberOfLines={1}>
          {(options('weekdays_short')[date.getDay()] ?? '').toUpperCase()}
        </Text>
      </View>
      <View style={styles.pageBody}>
        <View style={styles.pageDate}>
          <Text variant="display" style={[styles.pageDay, !easyReading && { fontFamily: FONTS.display }]}>
            {date.getDate()}
          </Text>
          <Text variant="bodySmall" tone="secondary">
            {(options('months')[date.getMonth()] ?? '').slice(0, 3)}
          </Text>
        </View>
        <Text variant="label" weight="bold" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="bodySmall" style={{ color: urgent ? colors.warning : colors.textSecondary }} numberOfLines={1}>
          {text}
        </Text>
      </View>
    </Tactile>
  );
}

/** The trail's rail beside each stop: the stop's key, and the path down to the next one. */
function Rail({ children, last, walked }: { children: ReactNode; last: boolean; walked: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.rail}>
      {children}
      {!last ? <View style={[styles.path, { backgroundColor: walked ? colors.success : colors.border }]} /> : null}
    </View>
  );
}

/** First stop of the day: the cards that are due. */
function ReviewStop({ due, last }: { due: number; last: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stop}>
      <Rail last={last} walked={false}>
        <IconTile icon="albums" size={32} />
      </Rail>
      <View style={styles.stopBody}>
        <Card onPress={() => router.push('/review')} accessibilityLabel={t('review.start')}>
          <Row gap={space.sm}>
            <View style={{ flex: 1 }}>
              <RichText variant="bodySmall">{t('review.today', { n: due, min: Math.max(1, Math.round((due * 8) / 60)) })}</RichText>
            </View>
            <Ionicons name="arrow-forward" size={18} color={colors.primary} />
          </Row>
        </Card>
      </View>
    </View>
  );
}

/** One stop of the day's trail: tick it, start a focus timer on it, or skip it. */
function PlanRow({ item, last, color, onDone, onSkip }: { item: TodayItem; last: boolean; color: string; onDone: () => void; onSkip: () => void }) {
  const { colors, easyReading } = useTheme();
  const done = item.status !== 'planned';
  // ENEM units open their own screen (simulado setup, redação, bank, Reta Final).
  const enem = enemRoute(item);
  const unit = UNITS[item.unitType] ?? UNITS.learn!;
  return (
    <View style={styles.stop}>
      <Rail last={last} walked={item.status === 'done'}>
        <Pressable
          disabled={done}
          onPress={() => {
            cheer();
            onDone();
          }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.status === 'done', disabled: done }}
          accessibilityLabel={`${t('today.item_done')}: ${item.title}`}
          hitSlop={8}
          style={({ pressed }) => [
            styles.check,
            {
              borderColor: item.status === 'done' ? colors.success : done ? colors.textSecondary : color,
              borderBottomWidth: pressed ? 2 : 4,
              marginTop: pressed ? 2 : 0,
              backgroundColor: item.status === 'done' ? colors.success : pressed ? `${color}33` : colors.surface1,
            },
          ]}
        >
          {item.status === 'done' ? <Ionicons name="checkmark" size={18} color={colors.onPrimary} /> : null}
          {item.status === 'skipped' ? <Ionicons name="remove" size={18} color={colors.textSecondary} /> : null}
        </Pressable>
      </Rail>
      <Pressable
        disabled={done || !enem}
        onPress={enem ? () => router.push(enem) : undefined}
        style={({ pressed }) => [
          styles.stopBody,
          styles.stopCard,
          { backgroundColor: done ? 'transparent' : colors.surface1, borderColor: done ? colors.border : colors.border, borderLeftColor: done ? colors.border : color },
          pressed && { backgroundColor: colors.surface2 },
        ]}
      >
        <View style={{ flex: 1, gap: 2, opacity: done ? 0.6 : 1 }}>
          <Text variant="label" style={[!easyReading && { fontFamily: FONTS.uiSemiBold }, done && { textDecorationLine: 'line-through' }]}>
            {item.title}
          </Text>
          <View style={styles.unit}>
            <Ionicons name={unit.icon} size={14} color={colors.textSecondary} />
            <Text variant="bodySmall" tone="secondary">
              {t(`plan.units.${unit.key}`)} · {item.minutes} min{item.status === 'done' ? `, ${t('plan.status.done').toLowerCase()}` : item.status === 'skipped' ? `, ${t('plan.status.skipped').toLowerCase()}` : ''}
            </Text>
          </View>
          {item.focus && !done ? (
            <Text variant="bodySmall" style={{ color: colors.lagoon }}>
              {item.focus}
            </Text>
          ) : null}
          {item.reason && !done ? (
            <Text variant="bodySmall" tone="secondary">
              {item.reason}
            </Text>
          ) : null}
        </View>
        {!done ? (
          <View style={styles.stopActions}>
            <IconButton
              icon="timer-outline"
              size={20}
              label={`${t('focus.start_for')}: ${item.title}`}
              onPress={() => router.push({ pathname: '/focus', params: { planItemId: item.id, label: item.title, ...(item.goalId ? { goalId: item.goalId } : {}), ...(item.subjectId ? { subjectId: item.subjectId } : {}) } })}
            />
            <IconButton icon="play-skip-forward-outline" size={20} color={colors.textSecondary} label={`${t('today.item_skip')}: ${item.title}`} onPress={onSkip} />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.xl, overflow: 'hidden', padding: space.lg, gap: space.md },
  // Two soft moons behind Capi give the panel a little depth.
  moon: { position: 'absolute', width: 220, height: 220, borderRadius: 110, right: -70, top: -90 },
  moonSmall: { position: 'absolute', width: 90, height: 90, borderRadius: 45, right: 96, top: -50 },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  capi: { marginTop: -space.sm, marginRight: -space.sm, marginBottom: -space.xl },
  goal: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'flex-start' },
  quick: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: -space.xs },
  quickKey: { minHeight: 40, minWidth: 56, paddingHorizontal: space.sm, alignItems: 'center', justifyContent: 'center' },
  bleed: { marginHorizontal: -(space.gutter) },
  exams: { paddingHorizontal: space.gutter, gap: space.sm, paddingBottom: space.xxs },
  page: { width: 116, overflow: 'hidden' },
  pageBand: { height: 26, alignItems: 'center', justifyContent: 'center' },
  holes: { position: 'absolute', top: 10, left: 10, right: 10, flexDirection: 'row', justifyContent: 'space-between' },
  hole: { width: 6, height: 6, borderRadius: 3 },
  pageBody: { paddingHorizontal: space.sm, paddingTop: space.xs, paddingBottom: space.sm, gap: 1 },
  pageDate: { flexDirection: 'row', alignItems: 'baseline', gap: space.xs },
  pageDay: { fontSize: 34, lineHeight: 38 },
  unit: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  stop: { flexDirection: 'row', gap: space.sm },
  rail: { width: 32, alignItems: 'center', paddingTop: space.sm },
  path: { flex: 1, width: 3, borderRadius: 2, marginTop: space.xs, marginBottom: -space.sm },
  stopBody: { flex: 1, marginBottom: space.sm },
  stopCard: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, borderLeftWidth: 4, paddingVertical: space.md, paddingLeft: space.md, paddingRight: space.xs },
  stopActions: { flexDirection: 'row', marginTop: -space.sm },
  check: { width: 30, height: 30, borderRadius: radius.sm, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
