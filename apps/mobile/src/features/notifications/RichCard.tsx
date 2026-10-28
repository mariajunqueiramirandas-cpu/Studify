// The in-app face of a rich notification (Central de notificações and the preview gallery). Same payload,
// same visual language as the native layouts in modules/studify-notify: a glyph badge in the accent color,
// then the template's block (tracker, countdown, ring, duel, bars, card, medal, stats, waveform, lines,
// message bubble).
import { Ionicons } from '@expo/vector-icons';
import type { RichNotification } from '@studify/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Card, ProgressBar, ProgressRing, Text, type IconName } from '../../components';
import { radius, space, useTheme } from '../../theme';
import { t } from '../../i18n';
import { countdownLabel } from './inbox';

const GLYPH_ICONS: Record<RichNotification['glyph'], IconName> = {
  book: 'book-outline',
  cards: 'layers-outline',
  quiz: 'help-circle-outline',
  trophy: 'trophy-outline',
  flame: 'flame-outline',
  calendar: 'calendar-outline',
  podcast: 'headset-outline',
  pen: 'create-outline',
  camera: 'camera-outline',
  people: 'people-outline',
  sparkles: 'sparkles-outline',
  timer: 'timer-outline',
  alert: 'alert-circle-outline',
  check: 'checkmark-circle-outline',
  map: 'map-outline',
  news: 'newspaper-outline',
};

const CHANNEL_ACCENT: Record<RichNotification['channel'], string> = {
  reviews: '#15803D',
  plan: '#4F46E5',
  class: '#C2410C',
  processing: '#0369A1',
  live: '#0369A1',
};

export function accentOf(n: RichNotification): string {
  return n.accent ?? CHANNEL_ACCENT[n.channel];
}

interface RichCardProps {
  n: RichNotification;
  /** "há 5 min"; omitted in previews. */
  time?: string;
  unread?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Buttons with their own deep link (the other kinds only make sense in the shade). */
  onOpenLink?: (link: string) => void;
  now?: Date;
  testID?: string;
}

export function RichCard({ n, time, unread, onPress, onLongPress, onOpenLink, now = new Date(), testID }: RichCardProps) {
  const accent = accentOf(n);
  const openActions = n.actions.filter((a) => a.kind === 'open' && a.deep_link);
  const meta = [n.sub, time].filter(Boolean).join(' · ');
  return (
    <Card onPress={onPress} onLongPress={onLongPress} accessibilityLabel={`${unread ? `${t('inbox.unread')}. ` : ''}${n.title}. ${n.body}`} style={unread ? { borderColor: accent, borderWidth: 1 } : null} testID={testID}>
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: `${accent}22` }]}>
          <Ionicons name={GLYPH_ICONS[n.glyph]} size={22} color={accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={2}>
            {n.title}
          </Text>
          {meta ? (
            <Text variant="bodySmall" tone="secondary" numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {unread ? <View style={[styles.dot, { backgroundColor: accent }]} accessibilityElementsHidden /> : null}
      </View>
      {n.body && n.template !== 'message' ? <Text variant="bodySmall">{n.body}</Text> : null}
      <Block n={n} accent={accent} now={now} />
      {openActions.length && onOpenLink ? (
        <View style={styles.actions}>
          {openActions.map((a) => (
            <Button key={a.id} variant="tonal" label={a.label} onPress={() => onOpenLink(a.deep_link!)} />
          ))}
        </View>
      ) : null}
      {n.template === 'progress' && n.progress?.state === 'running' ? (
        <Text variant="bodySmall" tone="secondary">
          {t('inbox.live_note')}
        </Text>
      ) : null}
    </Card>
  );
}

function Block({ n, accent, now }: { n: RichNotification; accent: string; now: Date }) {
  switch (n.template) {
    case 'progress':
      return n.progress ? <Tracker p={n.progress} accent={accent} /> : null;
    case 'countdown':
      return n.countdown ? <Countdown cd={n.countdown} accent={accent} now={now} /> : null;
    case 'goal':
      return n.goal ? <Goal g={n.goal} accent={accent} /> : null;
    case 'duel':
      return n.duel ? <Duel d={n.duel} accent={accent} /> : null;
    case 'score':
      return n.score ? <Score s={n.score} accent={accent} /> : null;
    case 'card':
      return n.card ? <CardFace card={n.card} accent={accent} /> : null;
    case 'achievement':
      return n.achievement ? <Medal a={n.achievement} accent={accent} /> : null;
    case 'retro':
      return n.retro ? <Retro r={n.retro} accent={accent} /> : null;
    case 'media':
      return n.media ? <Media m={n.media} accent={accent} /> : null;
    case 'digest':
      return n.digest ? <Digest lines={n.digest.lines} /> : null;
    case 'message':
      return n.message ? <Message m={n.message} accent={accent} /> : null;
    default:
      return null;
  }
}

type Of<K extends keyof RichNotification> = NonNullable<RichNotification[K]>;

/** Uber-style tracker: one segment per step, the current one half filled, a dot on the active edge. */
function Tracker({ p, accent }: { p: Of<'progress'>; accent: string }) {
  const { colors: c } = useTheme();
  const tone = p.state === 'failed' ? c.danger : accent;
  return (
    <View style={{ gap: space.xs }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(p.fraction * 100) }}>
      <View style={styles.segments}>
        {p.steps.map((s, i) => (
          <View key={i} style={[styles.segment, { backgroundColor: c.surface2 }]}>
            <View
              style={{
                height: '100%',
                width: s.state === 'done' ? '100%' : s.state === 'active' ? '50%' : s.state === 'failed' ? '100%' : '0%',
                backgroundColor: s.state === 'failed' ? c.danger : tone,
                borderRadius: 4,
              }}
            />
          </View>
        ))}
      </View>
      <View style={styles.stepLabels}>
        {p.steps.map((s, i) => (
          <Text key={i} variant="caption" tone={s.state === 'active' ? 'primary' : 'secondary'} weight={s.state === 'active' ? 'bold' : 'regular'} style={{ flex: 1 }} numberOfLines={1}>
            {s.state === 'done' ? '✓ ' : s.state === 'failed' ? '✕ ' : ''}
            {s.label}
          </Text>
        ))}
      </View>
      {p.eta_s !== undefined && p.state === 'running' ? (
        <Text variant="bodySmall" tone="secondary">
          {p.eta_s < 60 ? t('inbox.eta_soon') : t('inbox.eta', { n: Math.round(p.eta_s / 60) })}
        </Text>
      ) : null}
    </View>
  );
}

function Countdown({ cd, accent, now }: { cd: Of<'countdown'>; accent: string; now: Date }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.row}>
      {cd.readiness !== undefined ? (
        <ProgressRing value={cd.readiness} size={52} stroke={6} color={accent} label={t('inbox.readiness', { n: Math.round(cd.readiness * 100) })}>
          <Text variant="caption" weight="bold">
            {Math.round(cd.readiness * 100)}%
          </Text>
        </ProgressRing>
      ) : null}
      <View style={{ flex: 1, gap: space.xs }}>
        <Text variant="heading" style={{ color: accent }}>
          {countdownLabel(cd.target_at, now)}
        </Text>
        <Text variant="bodySmall" tone="secondary" numberOfLines={1}>
          {cd.label}
        </Text>
        {cd.chips.length ? (
          <View style={styles.chips}>
            {cd.chips.map((chip) => (
              <View key={chip} style={[styles.chip, { backgroundColor: c.surface2 }]}>
                <Text variant="caption">{chip}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Goal({ g, accent }: { g: Of<'goal'>; accent: string }) {
  const pct = Math.min(1, g.done_min / g.goal_min);
  return (
    <View style={styles.row}>
      <ProgressRing value={pct} size={56} stroke={7} color={accent} label={t('inbox.goal_minutes', { done: g.done_min, goal: g.goal_min })}>
        <Text variant="caption" weight="bold">
          {g.done_min}/{g.goal_min}
        </Text>
      </ProgressRing>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label">🔥 {t('inbox.days', { count: g.streak })}</Text>
        <Text variant="bodySmall" tone="secondary">
          {g.shields > 0 ? `${'🛡️'.repeat(g.shields)} ${t('inbox.shields', { count: g.shields })}` : t('inbox.no_shields')}
        </Text>
      </View>
    </View>
  );
}

function Duel({ d, accent }: { d: Of<'duel'>; accent: string }) {
  const { colors: c } = useTheme();
  const side = (s: Of<'duel'>['me'], color: string) => (
    <View style={{ flex: 1, alignItems: 'center', gap: 4 }}>
      <View style={[styles.avatar, { backgroundColor: color }]}>
        <Text variant="label" style={{ color: '#FFFFFF' }}>
          {initials(s.name)}
        </Text>
      </View>
      <Text variant="bodySmall" numberOfLines={1}>
        {s.name}
      </Text>
      {s.score !== undefined ? <Text variant="heading">{s.score}</Text> : null}
    </View>
  );
  return (
    <View style={{ gap: space.xs }}>
      <View style={styles.row}>
        {side(d.me, accent)}
        <View style={{ alignItems: 'center' }}>
          <Text variant="label" tone="secondary">
            {t('inbox.vs')}
          </Text>
          <Text variant="caption" style={{ color: accent }}>
            {t(`inbox.duel.${d.state}`)}
          </Text>
        </View>
        {side(d.them, c.textSecondary)}
      </View>
      {d.subject ? (
        <Text variant="bodySmall" tone="secondary" align="center">
          {d.subject}
        </Text>
      ) : null}
    </View>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase() || '?';
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','));

function Score({ s, accent }: { s: Of<'score'>; accent: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <View style={[styles.row, { alignItems: 'baseline' }]}>
        <Text variant="display" style={{ color: accent }}>
          {num(s.value)}
        </Text>
        <Text variant="bodySmall" tone="secondary">
          / {num(s.max)} · {s.label}
        </Text>
        {s.delta !== undefined && s.delta !== 0 ? (
          <Text variant="label" style={{ color: s.delta > 0 ? c.success : c.danger }}>
            {s.delta > 0 ? '▲' : '▼'} {num(Math.abs(s.delta))}
          </Text>
        ) : null}
      </View>
      {s.breakdown.map((b) => (
        <View key={b.label} style={{ gap: 2 }}>
          <View style={styles.between}>
            <Text variant="caption" tone="secondary">
              {b.label}
            </Text>
            <Text variant="caption">{Math.round(b.value * 100)}%</Text>
          </View>
          <ProgressBar value={b.value} color={accent} height={6} label={b.label} />
        </View>
      ))}
    </View>
  );
}

function CardFace({ card, accent }: { card: Of<'card'>; accent: string }) {
  const { colors: c } = useTheme();
  const [shown, setShown] = useState(false);
  return (
    <View style={[styles.cardFace, { borderColor: `${accent}55`, backgroundColor: c.bg }]}>
      <Text variant="body">{card.front}</Text>
      {card.back ? (
        shown ? (
          <>
            <View style={{ height: 1, backgroundColor: c.border }} />
            <Text variant="body" tone="secondary">
              {card.back}
            </Text>
          </>
        ) : (
          <Pressable onPress={() => setShown(true)} accessibilityRole="button" hitSlop={8}>
            <Text variant="label" style={{ color: accent }}>
              {t('inbox.reveal')}
            </Text>
          </Pressable>
        )
      ) : null}
      <Text variant="caption" tone="secondary">
        {t('inbox.cards_today', { count: card.due })}
      </Text>
    </View>
  );
}

function Medal({ a, accent }: { a: Of<'achievement'>; accent: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.medal, { borderColor: accent, backgroundColor: `${accent}1A` }]}>
        <Text style={{ fontSize: 30, lineHeight: 36 }}>{a.emoji}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label">{a.name}</Text>
        <Text variant="bodySmall" tone="secondary">
          {a.criterion}
        </Text>
      </View>
    </View>
  );
}

function Retro({ r, accent }: { r: Of<'retro'>; accent: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="heading" style={{ color: accent }}>
        {r.headline}
      </Text>
      <View style={styles.row}>
        {r.stats.map((s) => (
          <View key={s.label} style={[styles.stat, { backgroundColor: c.surface2 }]}>
            <Text variant="heading">{s.value}</Text>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// A fixed pseudo-waveform: the same silhouette as the native one, seeded by the duration.
function Media({ m, accent }: { m: Of<'media'>; accent: string }) {
  const bars = Array.from({ length: 28 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin((i + 1) * 1.7 + m.duration_s * 0.013)));
  const min = Math.floor(m.duration_s / 60);
  const sec = String(m.duration_s % 60).padStart(2, '0');
  return (
    <View style={styles.row}>
      <View style={[styles.play, { backgroundColor: accent }]}>
        <Ionicons name="play" size={18} color="#FFFFFF" />
      </View>
      <View style={styles.wave} accessibilityElementsHidden>
        {bars.map((h, i) => (
          <View key={i} style={{ flex: 1, height: `${Math.round(h * 100)}%`, backgroundColor: accent, opacity: 0.75, borderRadius: 2 }} />
        ))}
      </View>
      <Text variant="caption" tone="secondary">
        {min}:{sec}
      </Text>
    </View>
  );
}

function Digest({ lines }: { lines: string[] }) {
  return (
    <View style={{ gap: 2 }}>
      {lines.map((l, i) => (
        <Text key={i} variant="bodySmall" numberOfLines={1}>
          {l}
        </Text>
      ))}
    </View>
  );
}

function Message({ m, accent }: { m: Of<'message'>; accent: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.avatar, { backgroundColor: accent }]}>
        <Text variant="label" style={{ color: '#FFFFFF' }}>
          {initials(m.sender)}
        </Text>
      </View>
      <View style={[styles.bubble, { backgroundColor: c.surface2 }]}>
        <Text variant="caption" tone="secondary">
          {m.sender}
          {m.conversation ? ` · ${m.conversation}` : ''}
        </Text>
        <Text variant="bodySmall">{m.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badge: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  between: { flexDirection: 'row', justifyContent: 'space-between' },
  segments: { flexDirection: 'row', gap: 4, height: 8 },
  segment: { flex: 1, borderRadius: 4, overflow: 'hidden' },
  stepLabels: { flexDirection: 'row', gap: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.xs },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cardFace: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  medal: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  stat: { flex: 1, borderRadius: radius.md, padding: space.sm, alignItems: 'center', gap: 2 },
  play: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  wave: { flex: 1, height: 32, flexDirection: 'row', alignItems: 'center', gap: 2 },
  bubble: { flex: 1, borderRadius: radius.md, padding: space.sm, gap: 2 },
});
