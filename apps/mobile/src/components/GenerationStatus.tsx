// The one way the app shows a wait on generation (ADR 0011): what is being made, the step it is on, a bar (filled
// when the server reports how much is done, gliding when it does not), how long it has been running, the time
// left once it can be estimated, and — when the work goes on without the screen — that the student can leave.
// Failures say what happened and offer to try again. Every generation screen uses it, so waits look and read alike.
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { etaSeconds } from '@studify/shared';
import { formatDuration, useElapsed } from '../features/progress/time';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { Button } from './Button';
import { Card } from './Card';
import { IndeterminateBar, ProgressBar } from './Progress';
import { Text } from './Text';

export interface GenerationStatusProps {
  /** What is being made, in the student's words: "Montando sua Prova Provável". */
  title: string;
  /** The step it is on, when known: "Questões · 3 de 8". */
  detail?: string | null;
  /** Share done (0–1) when the server reports it; without it the bar glides. */
  fraction?: number | null;
  /** When the work started (the job's started_at, or the tap); counts from the first render without it. */
  startedAt?: number | string | null;
  /** Waiting for a free slot on the server. */
  queued?: boolean;
  /** After this many seconds the card says it is slower than usual. */
  slowAfterS?: number;
  /** The work goes on without this screen (a server job): say so, and that the student will be told. */
  canLeave?: boolean;
  /** The failure, in PT-BR; with `onRetry`, a button to try again. */
  error?: string | null;
  onRetry?: () => void;
  /** Inside a sheet, a panel or under a button: no card around it. */
  compact?: boolean;
}

export function GenerationStatus({ title, detail, fraction, startedAt, queued, slowAfterS = 25, canLeave, error, onRetry, compact }: GenerationStatusProps) {
  const { colors: c } = useTheme();
  const elapsed = useElapsed(startedAt, !error);
  if (error) {
    return (
      <View accessibilityRole="alert" style={{ gap: space.sm, padding: compact ? 0 : space.md, borderRadius: radius.lg, backgroundColor: compact ? undefined : c.dangerSoft }}>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
          <Ionicons name="alert-circle" size={22} color={c.danger} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">{title}</Text>
            <Text variant="bodySmall">{error}</Text>
          </View>
        </View>
        {onRetry ? <Button variant="secondary" icon="refresh" label={t('global.retry')} onPress={onRetry} /> : null}
      </View>
    );
  }

  const known = typeof fraction === 'number' && Number.isFinite(fraction);
  const eta = known ? etaSeconds(fraction, elapsed) : null;
  const time = queued
    ? t('wait.queued')
    : [t('wait.elapsed', { time: formatDuration(elapsed) }), eta !== null ? t('wait.eta', { time: formatDuration(eta) }) : null].filter(Boolean).join(' · ');
  const slow = !queued && elapsed >= slowAfterS && (eta === null || eta > 60);
  const body = (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primarySoft }}>
          <Ionicons name={queued ? 'time-outline' : 'sparkles-outline'} size={20} color={c.primary} />
        </View>
        <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
          <Text variant="label">{title}</Text>
          {detail ? (
            <Text variant="bodySmall" tone="secondary">
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      {known ? <ProgressBar value={fraction} label={detail ?? title} /> : <IndeterminateBar label={detail ?? title} />}
      <Text variant="caption" tone="secondary">
        {time}
      </Text>
      {slow || (canLeave && elapsed >= 8) ? (
        <Text variant="caption" tone="secondary">
          {[slow ? t('wait.slow') : null, canLeave ? t('wait.leave') : null].filter(Boolean).join(' ')}
        </Text>
      ) : null}
    </View>
  );
  return compact ? body : <Card tone="soft">{body}</Card>;
}
