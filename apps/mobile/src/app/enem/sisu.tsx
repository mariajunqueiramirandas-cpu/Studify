import type { SisuManual, SisuScores } from '@studify/shared';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, ListItem, NumberStepper, Row, Screen, Section, SkeletonList, Text, TextField, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { computeTargets, deleteSisuTarget, saveSisuTarget, useEnemGoal, useEstimates, useSisuOffers, useSisuTargets, type SisuOffer, type SisuTargetRow } from '../../features/enem/api';
import { areaName } from '../../features/enem/components';
import { recomputePlan } from '../../features/goals/api';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

const KEYS = ['LC', 'CH', 'CN', 'MT', 'RED'] as const;
const DEFAULT_WEIGHTS: SisuScores = { LC: 1, CH: 1, CN: 1, MT: 1, RED: 1 };

/**
 * S-ENEM Meta SISU (ENM-06): up to 3 targets (offer search or manual weights and cut-off), targets per area from the
 * student's estimates (spec 09 §8.4), "Você está a {x} pontos da meta". Only a cut-off and an optional free label:
 * never asks why a modality applies (ENM-06.5); targets are never shared with the Turma.
 */
export default function MetaSisu() {
  const { userId } = useSession();
  const overlay = useOverlay();
  const { goal } = useEnemGoal();
  const targets = useSisuTargets(goal?.id);
  const { estimates } = useEstimates();
  const [editing, setEditing] = useState<{ priority: number; existing: SisuTargetRow | null } | null>(null);

  if (!goal) return <Screen title={t('sisu.title')} onBack={() => router.back()}><SkeletonList rows={3} /></Screen>;
  const rows = targets.data ?? [];
  if (editing) {
    return (
      <TargetEditor
        priority={editing.priority}
        existing={editing.existing}
        estimates={estimates}
        onCancel={() => setEditing(null)}
        onSave={async (v) => {
          try {
            await saveSisuTarget(userId!, { goalId: goal.id, existingId: editing.existing?.id ?? null, priority: editing.priority, ...v });
            await targets.refetch();
            void recomputePlan('manual_edit', goal.id).catch(() => undefined);
            setEditing(null);
          } catch (e) {
            overlay.snack(messageFor(e));
          }
        }}
      />
    );
  }
  return (
    <Screen title={t('sisu.title')} onBack={() => router.back()}>
      <Banner kind="neutral" message={t('sisu.private')} />
      {rows.map((r) => {
        const fresh = r.manual ? computeTargets(r.manual.weights, estimates, Number(r.cutoff_used), Number(r.margin), r.manual.min_scores) : r.targets;
        return (
          <Card key={r.id} onPress={() => setEditing({ priority: r.priority, existing: r })}>
            <Text variant="caption" tone="secondary">
              {t('sisu.priority', { n: r.priority })}
            </Text>
            <Text variant="heading">{r.manual?.label ?? '—'}</Text>
            <Text variant="bodySmall">
              {t('sisu.cutoff_label')}: {String(r.cutoff_used).replace('.', ',')}
              {r.modality_label ? ` · ${r.modality_label}` : ''}
            </Text>
            <Results value={fresh} />
          </Card>
        );
      })}
      {rows.length < 3 ? <Button icon="add" label={rows.length ? t('sisu.add') : t('sisu.title')} onPress={() => setEditing({ priority: rows.length + 1, existing: null })} /> : null}
      <Text variant="caption" tone="secondary">
        {t('sisu.cutoff.note')}
      </Text>
      {rows.length ? <Button variant="destructive" label={t('sisu.remove')} onPress={() => void deleteSisuTarget(rows[rows.length - 1]!.id).then(() => targets.refetch())} /> : null}
    </Screen>
  );
}

function Results({ value }: { value: SisuTargetRow['targets'] }) {
  if (!value) return null;
  if (value.status === 'missing_estimates') return <Text variant="bodySmall" tone="secondary">{t('sisu.missing', { areas: value.missing.map((k) => areaName(k)).join(', ') })}</Text>;
  return (
    <View style={{ gap: space.xs }}>
      {value.current !== null ? <Text variant="bodySmall">{t('sisu.current', { n: value.current.toFixed(1).replace('.', ',') })}</Text> : null}
      {value.status === 'above' ? <Text tone="success">{t('sisu.above')}</Text> : null}
      {value.status === 'impossible' ? <Banner kind="warning" message={t('sisu.impossible')} /> : null}
      {value.status === 'ok' && value.gap ? <Text variant="label">{t('sisu.gap', { x: Math.ceil(value.gap) })}</Text> : null}
      {value.display ? (
        <>
          <Text variant="label">{t('sisu.targets')}</Text>
          {KEYS.map((k) => (
            <Row key={k}>
              <Text style={{ flex: 1 }}>{areaName(k)}</Text>
              <Text variant="label">{value.display![k]}</Text>
            </Row>
          ))}
        </>
      ) : null}
    </View>
  );
}

interface EditorValue {
  offer: SisuOffer | null;
  manual: SisuManual | null;
  cutoff: number;
  margin: number;
  modalityLabel: string | null;
  targets: NonNullable<SisuTargetRow['targets']>;
}

function TargetEditor({ priority, existing, estimates, onCancel, onSave }: { priority: number; existing: SisuTargetRow | null; estimates: Partial<SisuScores>; onCancel: () => void; onSave: (v: EditorValue) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const offers = useSisuOffers(query);
  const [offer, setOffer] = useState<SisuOffer | null>(null);
  const [label, setLabel] = useState(existing?.manual?.label ?? '');
  const [weights, setWeights] = useState<SisuScores>(existing?.manual?.weights ?? DEFAULT_WEIGHTS);
  const [cutoff, setCutoff] = useState(existing ? String(existing.cutoff_used) : '');
  const [margin, setMargin] = useState(existing ? Number(existing.margin) : 15);
  const [modality, setModality] = useState(existing?.modality_label ?? '');
  const [busy, setBusy] = useState(false);
  const cutoffN = Number(cutoff.replace(',', '.'));
  const valid = (offer || label.trim().length > 0) && cutoffN > 0 && cutoffN <= 1000 && KEYS.some((k) => weights[k] > 0);
  const preview = useMemo(() => (valid ? computeTargets(offer?.weights ?? weights, estimates, cutoffN, margin, offer?.min_scores) : null), [valid, offer, weights, estimates, cutoffN, margin]);

  return (
    <Screen
      title={t('sisu.priority', { n: priority })}
      onBack={onCancel}
      footer={
        <ActionBar>
          <Button
            label={t('sisu.save')}
            loading={busy}
            disabled={!valid || !preview}
            onPress={async () => {
              setBusy(true);
              await onSave({ offer, manual: offer ? null : { label: label.trim(), weights }, cutoff: cutoffN, margin, modalityLabel: modality.trim() || null, targets: preview! });
              setBusy(false);
            }}
          />
        </ActionBar>
      }
    >
      <TextField label={t('sisu.search')} value={query} onChangeText={setQuery} />
      {(offers.data ?? []).map((o) => (
        <ListItem
          key={o.id}
          title={`${o.course} — ${o.institution_acronym ?? o.institution}`}
          subtitle={[o.campus, o.shift, o.edition_year].filter(Boolean).join(' · ')}
          onPress={() => {
            setOffer(o);
            setWeights(o.weights);
            const first = o.cutoffs[0];
            if (first) setCutoff(String(first.cutoff));
          }}
        />
      ))}
      {offer ? (
        <Card tone="soft">
          <Text variant="label">{`${offer.course} — ${offer.institution}`}</Text>
          {offer.cutoffs.length ? <Text variant="caption">{t('sisu.cutoffs')}</Text> : null}
          {offer.cutoffs.map((c) => (
            <Text key={`${c.modality_label}-${c.edition}`} variant="caption" tone="secondary">
              {c.modality_label}: {c.cutoff} ({c.edition})
            </Text>
          ))}
          <Button compact variant="text" label={t('global.cancel')} onPress={() => setOffer(null)} />
        </Card>
      ) : (
        <Section title={t('sisu.manual')}>
          <TextField label={t('sisu.label')} value={label} onChangeText={setLabel} maxLength={120} />
          <Text variant="label">{t('sisu.weights')}</Text>
          {KEYS.map((k) => (
            <NumberStepper key={k} label={areaName(k)} value={weights[k]} min={0} max={10} onChange={(v) => setWeights((w) => ({ ...w, [k]: v }))} />
          ))}
        </Section>
      )}
      <TextField label={offer ? `${t('sisu.cutoff_label')} (${t('sisu.informed')})` : t('sisu.cutoff_label')} value={cutoff} onChangeText={setCutoff} keyboardType="decimal-pad" />
      <NumberStepper label={t('sisu.margin')} value={margin} min={0} max={100} step={5} onChange={setMargin} />
      <TextField label={t('sisu.modality')} hint={t('sisu.modality_hint')} value={modality} onChangeText={setModality} maxLength={60} />
      {preview ? (
        <Card>
          <Results value={preview} />
        </Card>
      ) : null}
      <Text variant="caption" tone="secondary">
        {t('sisu.cutoff.note')}
      </Text>
    </Screen>
  );
}
