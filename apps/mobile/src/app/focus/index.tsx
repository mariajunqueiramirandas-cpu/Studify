import { FOCUS_LIMITS, FOCUS_PRESETS, blockingAllowed, focusPhases, focusTotalMinutes, validateFocusConfig, xpFor, type FocusConfig } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import {
  ActionBar,
  Banner,
  Button,
  Capi,
  Card,
  Celebrate,
  ListItem,
  NumberStepper,
  ProgressRing,
  Screen,
  Section,
  SegmentedControl,
  SwitchRow,
  Text,
  useOverlay,
} from '../../components';
import { useDb } from '../../db/DatabaseProvider';
import { useSession } from '../../features/auth/session';
import { useBlocklist } from '../../features/focus/blocklist';
import { finishFocus, syncFocusNative, type FocusSummary } from '../../features/focus/session';
import { updatePlanItem } from '../../features/goals/api';
import { useCapi } from '../../features/motivation/capi';
import { CapiCheer } from '../../features/motivation/CapiCheer';
import { t } from '../../i18n';
import { focusBlocker } from '../../platform/focus';
import { requestNotificationPermission } from '../../platform/notifications';
import type { FocusPermissionState } from '../../platform/types';
import { runPosition, useFocusStore, type FocusPresetId, type FocusRun } from '../../stores/focus';
import { space } from '../../theme';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Re-reads the special-access grants whenever the student comes back from system settings. */
function usePermissions(): FocusPermissionState {
  const [perm, setPerm] = useState<FocusPermissionState>(() => focusBlocker.permissions());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setPerm(focusBlocker.permissions());
    });
    return () => sub.remove();
  }, []);
  return perm;
}

/** S-FOCO Modo foco (WEL-01/02): presets, big countdown, pause/skip, Capi focada, break screen. */
export default function FocusScreen() {
  const run = useFocusStore((s) => s.run);
  const [summary, setSummary] = useState<(FocusSummary & { planItemId: string | null }) | null>(null);
  if (summary) return <SummaryView summary={summary} />;
  if (run) return <RunningView run={run} onFinished={setSummary} />;
  return <SetupView />;
}

function SetupView() {
  const params = useLocalSearchParams<{ planItemId?: string; goalId?: string; subjectId?: string; label?: string }>();
  const db = useDb();
  const store = useFocusStore();
  const perm = usePermissions();
  const capi = useCapi();
  const blocked = useBlocklist().data ?? [];
  const [preset, setPreset] = useState<FocusPresetId>(store.lastPreset);
  const [custom, setCustom] = useState<FocusConfig>(store.lastConfig);
  const config: FocusConfig = preset === 'custom' ? custom : FOCUS_PRESETS.find((p) => p.id === preset)!.config;
  const errors = validateFocusConfig(config);
  const canBlock = focusBlocker.available;
  const blockReady = perm.usage && perm.overlay;
  const blockTooLong = store.blockEnabled && !blockingAllowed(config);

  const start = async () => {
    await requestNotificationPermission().catch(() => false);
    store.start({
      config,
      preset,
      block: canBlock && store.blockEnabled && blockReady && blocked.length > 0,
      dnd: canBlock && store.dndEnabled && perm.dnd,
      planItemId: params.planItemId ?? null,
      goalId: params.goalId ?? null,
      subjectId: params.subjectId ?? null,
      label: params.label ?? null,
    });
    syncFocusNative(db);
  };

  return (
    <Screen
      title={t('focus.title')}
      footer={
        <ActionBar>
          <Button icon="play" label={t('focus.start')} onPress={start} disabled={errors.length > 0} />
        </ActionBar>
      }
    >
      <View style={{ alignItems: 'center', gap: space.xs }}>
        {capi.visible ? <Capi stage={capi.stage} mood="focused" accessories={capi.accessories} size={96} /> : null}
        {params.label ? <Text variant="heading" align="center">{params.label}</Text> : null}
        <Text tone="secondary" align="center">
          {t('focus.total', { n: focusTotalMinutes(config) })}
        </Text>
      </View>
      <SegmentedControl
        label={t('focus.preset')}
        value={preset}
        onChange={setPreset}
        options={[
          { value: '25_5', label: '25/5' },
          { value: '50_10', label: '50/10' },
          { value: 'custom', label: t('focus.custom') },
        ]}
      />
      {preset === 'custom' ? (
        <Card>
          <NumberStepper label={t('focus.focus_min')} value={custom.focusMin} min={FOCUS_LIMITS.focusMin[0]} max={FOCUS_LIMITS.focusMin[1]} step={5} onChange={(v) => setCustom({ ...custom, focusMin: v })} format={(v) => `${v} min`} />
          <NumberStepper label={t('focus.break_min')} value={custom.breakMin} min={FOCUS_LIMITS.breakMin[0]} max={FOCUS_LIMITS.breakMin[1]} onChange={(v) => setCustom({ ...custom, breakMin: v })} format={(v) => `${v} min`} />
          <NumberStepper label={t('focus.cycles')} value={custom.cycles} min={FOCUS_LIMITS.cycles[0]} max={FOCUS_LIMITS.cycles[1]} onChange={(v) => setCustom({ ...custom, cycles: v })} />
          <Text variant="caption" tone="secondary">
            {t('focus.long_break_hint')}
          </Text>
        </Card>
      ) : null}

      <Section title={t('focus.options')}>
        <Text variant="bodySmall" tone="secondary">
          {t('focus.soft_hint')}
        </Text>
        {canBlock ? (
          <>
            <SwitchRow label={t('focus.block')} hint={t('focus.block_hint')} value={store.blockEnabled} onChange={(v) => store.setPrefs({ blockEnabled: v })} />
            {store.blockEnabled ? (
              <Card tone="outline">
                {!blockReady ? (
                  <>
                    <Text>{t('focus.perm_why')}</Text>
                    {!perm.usage ? <Button variant="secondary" icon="stats-chart-outline" label={t('focus.perm_usage')} onPress={() => focusBlocker.openUsageAccessSettings()} /> : null}
                    {!perm.overlay ? <Button variant="secondary" icon="layers-outline" label={t('focus.perm_overlay')} onPress={() => focusBlocker.openOverlaySettings()} /> : null}
                    <Text variant="caption" tone="secondary">
                      {t('focus.perm_revoke')}
                    </Text>
                  </>
                ) : null}
                <ListItem icon="apps-outline" title={t('focus.pick_apps')} subtitle={t('focus.apps_count', { n: blocked.length })} onPress={() => router.push('/focus/apps')} />
                {blockTooLong ? <Banner kind="warning" message={t('focus.block_max')} /> : null}
              </Card>
            ) : null}
            <SwitchRow label={t('focus.dnd')} hint={t('focus.dnd_hint')} value={store.dndEnabled && perm.dnd} onChange={(v) => (v && !perm.dnd ? focusBlocker.openDndSettings() : store.setPrefs({ dndEnabled: v }))} />
          </>
        ) : null}
      </Section>
    </Screen>
  );
}

function RunningView({ run, onFinished }: { run: FocusRun; onFinished: (s: FocusSummary & { planItemId: string | null }) => void }) {
  const db = useDb();
  const { userId } = useSession();
  const overlay = useOverlay();
  const capi = useCapi();
  const store = useFocusStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const finish = () => {
      if (!userId) return;
      const planItemId = useFocusStore.getState().run?.planItemId ?? null;
      const s = finishFocus(db, userId);
      if (s) onFinished({ ...s, planItemId });
    };
    const timer = setInterval(() => {
      const at = Date.now();
      const current = useFocusStore.getState().run;
      if (current && (current.stopRequestedAt !== null || runPosition(current, at).done)) {
        finish();
        return;
      }
      setNow(at);
    }, 1000);
    return () => clearInterval(timer);
  }, [db, userId, onFinished]);

  const phases = focusPhases(run.config);
  const pos = runPosition(run, now);
  const phase = pos.phase ?? phases[phases.length - 1]!;
  const isBreak = phase.kind !== 'focus';
  const paused = run.pausedAt !== null;
  const progress = 1 - pos.remainingMs / (phase.minutes * 60_000);

  const act = (fn: () => void) => {
    fn();
    syncFocusNative(db);
    setNow(Date.now());
  };

  const stop = async () => {
    if (!(await overlay.confirm({ title: t('focus.stop_confirm'), confirmLabel: t('focus.stop'), cancelLabel: t('global.stay') }))) return;
    store.requestStop();
    if (!userId) return;
    const planItemId = run.planItemId;
    const s = finishFocus(db, userId);
    if (s) onFinished({ ...s, planItemId });
  };

  return (
    <Screen
      title={t('focus.title')}
      calm={isBreak}
      footer={
        <ActionBar>
          <Button variant="secondary" icon={paused ? 'play' : 'pause'} label={paused ? t('focus.resume') : t('focus.pause')} onPress={() => act(() => (paused ? store.resume() : store.pause()))} />
          <Button variant="text" icon="play-skip-forward" label={t('focus.skip')} onPress={() => act(() => store.skip())} />
          <Button variant="text" icon="stop" label={t('focus.stop')} onPress={stop} />
        </ActionBar>
      }
    >
      <View style={{ alignItems: 'center', gap: space.md, paddingTop: space.lg }}>
        <Text variant="heading">{t(`focus.phase.${phase.kind}`)}</Text>
        {/* The timer is not announced every second (mobile-app.md §11): the label carries the phase end. */}
        <ProgressRing value={Math.max(0, Math.min(1, progress))} size={220} stroke={12} label={t('focus.remaining_a11y', { time: mmss(pos.remainingMs) })}>
          <Text variant="display" style={{ fontSize: 52, lineHeight: 60 }} accessible={false}>
            {mmss(pos.remainingMs)}
          </Text>
        </ProgressRing>
        <Text tone="secondary">{t('focus.cycle', { n: phase.cycle, total: run.config.cycles })}</Text>
        {paused ? <Banner kind="neutral" message={t('focus.paused_hint')} /> : null}
        {capi.visible ? <Capi stage={capi.stage} mood={isBreak ? 'resting' : 'focused'} accessories={capi.accessories} size={96} /> : null}
        {run.label ? <Text variant="label" align="center">{run.label}</Text> : null}
        {/* WEL-01.7: breaks suggest moving away from the screen, never more studying. */}
        {isBreak ? <Banner kind="success" icon="cafe-outline" message={t('focus.break_hint')} /> : null}
        {run.block ? (
          <Text variant="caption" tone="secondary" align="center">
            {isBreak ? t('focus.block_paused') : t('focus.block_on')}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

function SummaryView({ summary }: { summary: FocusSummary & { planItemId: string | null } }) {
  const overlay = useOverlay();
  const xp = summary.cycles * xpFor({ kind: 'focus_cycle_completed' }, { dailyGoalXpAwarded: false, noteXpToday: 0, podcastsToday: 0 });
  const markDone = async () => {
    if (!summary.planItemId) return;
    await updatePlanItem(summary.planItemId, { status: 'done' }).catch(() => overlay.snack(t('offline.queued')));
    router.back();
  };
  return (
    <Screen
      title={t('focus.title')}
      footer={
        <ActionBar>
          {summary.planItemId ? <Button icon="checkmark" label={t('focus.mark_done')} onPress={markDone} /> : null}
          <Button variant={summary.planItemId ? 'text' : 'primary'} label={t('global.done')} onPress={() => router.back()} />
        </ActionBar>
      }
    >
      <CapiCheer happy={summary.cycles > 0} />
      <Celebrate text={summary.cycles >= summary.cyclesPlanned ? '🎉' : '💪'} />
      <Text variant="title" align="center">
        {t('focus.summary_cycles', { n: summary.cycles, total: summary.cyclesPlanned })}
      </Text>
      <Card>
        <Text>{t('focus.summary_minutes', { n: summary.minutes })}</Text>
        {xp > 0 ? <Text>{t('focus.summary_xp', { n: xp })}</Text> : null}
        <Text tone="secondary">{summary.interruptions ? t('focus.summary_interruptions', { n: summary.interruptions }) : t('focus.summary_no_interruptions')}</Text>
        {summary.blockedAttempts > 0 ? <Text tone="secondary">{t('focus.summary_blocked', { n: summary.blockedAttempts })}</Text> : null}
      </Card>
    </Screen>
  );
}
