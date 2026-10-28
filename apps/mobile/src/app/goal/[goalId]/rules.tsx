import { GRADING_PRESET_IDS, GRADING_PRESETS, gradingPreset, parseGradingFormula, type GradingFormula, type GradingPresetId } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionBar, Button, NumberStepper, RadioList, Screen, Section, SegmentedControl, SwitchRow, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { recomputePlan, saveGradingRule, useGoal, useGradingData } from '../../../features/goals/api';
import { options, t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** S-OBJ-14 Regras da escola: presets + "Personalizar" (GOL-06.1). */
export default function Rules() {
  const { goalId, then } = useLocalSearchParams<{ goalId: string; then?: string }>();
  const { userId } = useSession();
  const goal = useGoal(goalId);
  const year = goal.data?.school_year ?? new Date().getFullYear();
  const data = useGradingData(year);
  const overlay = useOverlay();
  const existing = data.data?.rules.find((r) => r.subject_id === null);
  const [preset, setPreset] = useState<GradingPresetId>('media_simples_6');
  const [formula, setFormula] = useState<GradingFormula>(gradingPreset('media_simples_6'));
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const recoveryLabels = options('rules.recovery_options');

  useEffect(() => {
    if (!existing) return;
    const parsed = parseGradingFormula(existing.formula);
    if (parsed.ok) setFormula(parsed.formula);
    if (existing.preset_key && (GRADING_PRESET_IDS as readonly string[]).includes(existing.preset_key)) setPreset(existing.preset_key as GradingPresetId);
    else setCustom(true);
  }, [existing]);

  const save = async () => {
    setBusy(true);
    try {
      await saveGradingRule(userId!, year, formula, custom ? null : preset, null, existing?.id);
      void recomputePlan('grade_logged', goalId).catch(() => undefined);
      overlay.snack(t('rules.saved'));
      if (then === 'plan') router.replace({ pathname: '/goal/[goalId]/plan', params: { goalId, ready: '1' } });
      else router.back();
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('rules.title')}
      footer={
        <ActionBar>
          <Button label={t('global.save')} loading={busy} onPress={save} />
        </ActionBar>
      }
    >
      <Section title={t('rules.presets')}>
        <RadioList<GradingPresetId>
          value={custom ? null : preset}
          onChange={(id) => {
            setCustom(false);
            setPreset(id);
            setFormula(gradingPreset(id));
          }}
          options={GRADING_PRESET_IDS.map((id) => ({ value: id, label: GRADING_PRESETS[id].label }))}
        />
      </Section>
      <SwitchRow label={t('rules.customize')} value={custom} onChange={setCustom} />
      {custom ? (
        <Section>
          <SegmentedControl<'10' | '100'>
            label={t('rules.scale')}
            value={formula.scale_max === 100 ? '100' : '10'}
            onChange={(v) => setFormula({ ...formula, scale_max: Number(v), passing_average: v === '100' ? 60 : 6, grade_step: v === '100' ? 1 : 0.1 })}
            options={[
              { value: '10', label: t('rules.scale_10') },
              { value: '100', label: t('rules.scale_100') },
            ]}
          />
          <NumberStepper label={t('rules.passing')} value={formula.passing_average} onChange={(v) => setFormula({ ...formula, passing_average: v })} min={0} max={formula.scale_max} step={formula.scale_max === 100 ? 5 : 0.5} format={(v) => String(v).replace('.', ',')} />
          <NumberStepper
            label={formula.terms.label}
            value={formula.terms.count}
            onChange={(v) => setFormula({ ...formula, terms: { ...formula.terms, count: v, weights: Array.from({ length: v }, (_, i) => formula.terms.weights[i] ?? 1) } })}
            min={1}
            max={4}
          />
          {formula.terms.weights.map((w, i) => (
            <NumberStepper key={i} label={`${t('exam.weight')} ${i + 1}º ${formula.terms.label}`} value={w} onChange={(v) => setFormula({ ...formula, terms: { ...formula.terms, weights: formula.terms.weights.map((x, j) => (j === i ? v : x)) } })} min={1} max={5} />
          ))}
          <Text variant="label">{t('rules.recovery')}</Text>
          <RadioList
            value={formula.recovery.type === 'none' ? 'none' : formula.recovery.type === 'average_with_original' ? 'avg' : 'replace'}
            onChange={(v) => setFormula({ ...formula, recovery: { ...formula.recovery, type: v === 'none' ? 'none' : v === 'avg' ? 'average_with_original' : 'replace_capped' } })}
            options={[
              { value: 'none', label: recoveryLabels[0] ?? '' },
              { value: 'replace', label: recoveryLabels[1] ?? '' },
              { value: 'avg', label: recoveryLabels[2] ?? '' },
            ]}
          />
        </Section>
      ) : null}
    </Screen>
  );
}
