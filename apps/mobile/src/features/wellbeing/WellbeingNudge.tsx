// The burnout guard's nudge (WEL-03): a suggestion, never a block. Always "Agora não" and a way to turn the
// nudges off; the check-in-low nudge brings the help card instead.
import { Banner, Button, Row, useOverlay } from '../../components';
import { t } from '../../i18n';
import { useBurnoutNudge, type GuardOptions } from './guard';
import { HelpCard } from './HelpCard';
import { messageFor } from '../../api/messages';

export function WellbeingNudge(props: GuardOptions) {
  const overlay = useOverlay();
  // Callers memoize `sessionItems` so the guard is not re-armed on every render.
  const { nudge, dismiss, rebalance, disable, acted } = useBurnoutNudge(props);
  if (!nudge) return null;
  const key = nudge.kind === 'long_session' && nudge.strong ? 'long_session_strong' : nudge.kind;
  if (nudge.kind === 'checkin_low') {
    return (
      <>
        <Banner kind="info" icon="heart-outline" message={t('burnout.checkin_low')} onDismiss={dismiss} />
        <HelpCard />
      </>
    );
  }
  return (
    <Banner kind="neutral" icon={nudge.kind === 'late_night' ? 'moon-outline' : 'leaf-outline'} message={t(`burnout.${key}`)} onDismiss={dismiss}>
      <Row wrap>
        {nudge.action === 'rebalance' ? (
          <Button
            compact
            variant="tonal"
            label={t('burnout.rebalance')}
            onPress={() =>
              void rebalance().then(
                () => overlay.snack(t('burnout.rebalanced')),
                (e: unknown) => overlay.snack(messageFor(e)),
              )
            }
          />
        ) : nudge.kind === 'long_session' || nudge.kind === 'performance_drop' ? (
          <Button
            compact
            variant="tonal"
            label={t('burnout.take_break')}
            onPress={() => {
              acted();
              overlay.snack(t('burnout.break_snack'));
            }}
          />
        ) : null}
        <Button compact variant="text" label={t('burnout.not_now')} onPress={dismiss} />
        <Button compact variant="text" label={t('burnout.turn_off')} onPress={() => void disable()} />
      </Row>
    </Banner>
  );
}
