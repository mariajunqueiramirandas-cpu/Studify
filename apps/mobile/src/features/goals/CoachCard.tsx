import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View } from 'react-native';
import { BottomSheet, Card, Chip, Row, Text } from '../../components';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';
import type { PlanCoach } from './api';

const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

/** GOL-04.10 on Hoje: the coach headline and the next steps; the sheet shows each test's strategy and the priorities. */
export function CoachCard({ coach }: { coach: PlanCoach }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const steps = coach.next_steps.slice(0, 3);
  const priorities = [...coach.topics].sort((a, b) => b.priority - a.priority).slice(0, 5);
  return (
    <>
      <Card tone="soft" onPress={() => setOpen(true)} accessibilityLabel={`${t('coach.title')}: ${coach.headline}`}>
        <Row>
          <Ionicons name="sparkles-outline" size={18} color={colors.primary} />
          <Text variant="label" tone="accent">
            {t('coach.title')}
          </Text>
        </Row>
        <Text variant="heading">{coach.headline}</Text>
        {coach.watch_out ? (
          <Row>
            <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
            <Text variant="bodySmall" tone="warning" style={{ flex: 1 }}>
              {coach.watch_out}
            </Text>
          </Row>
        ) : null}
        <View style={{ gap: space.sm }}>
          {steps.map((s, i) => (
            <Row key={`${s.when}-${i}`}>
              <Text variant="label" tone="accent" style={{ width: 20 }}>
                {i + 1}.
              </Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label">{s.title}</Text>
                <Text variant="bodySmall" tone="secondary">
                  {t(`coach.when.${s.when}`)} · {s.detail}
                </Text>
              </View>
            </Row>
          ))}
        </View>
        <Text variant="label" tone="accent">
          {t('coach.open')}
        </Text>
      </Card>

      <BottomSheet visible={open} onClose={() => setOpen(false)} title={t('coach.title')}>
        <Text variant="heading">{coach.headline}</Text>
        {coach.exams.map((e) => (
          <View key={e.exam_id} style={{ gap: space.xs }}>
            <Row>
              <Text variant="label" style={{ flex: 1 }}>
                {e.title}
              </Text>
              <Chip label={t(`coach.risk.${e.risk}`)} tone={RISK_TONE[e.risk]} />
            </Row>
            <Text tone="secondary">{e.strategy}</Text>
          </View>
        ))}
        {priorities.length ? (
          <View style={{ gap: space.sm }}>
            <Text variant="label">{t('coach.priorities')}</Text>
            {priorities.map((p) => (
              <View key={p.node_id} style={{ gap: 2 }}>
                <Text variant="label">{p.title}</Text>
                <Text variant="bodySmall">{p.focus}</Text>
                <Text variant="bodySmall" tone="secondary">
                  {p.why}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('coach.steps')}</Text>
          {coach.next_steps.map((s, i) => (
            <View key={`${s.when}-${i}`} style={{ gap: 2 }}>
              <Text variant="label">
                {i + 1}. {s.title}
              </Text>
              <Text variant="bodySmall" tone="secondary">
                {t(`coach.when.${s.when}`)} · {s.detail}
              </Text>
            </View>
          ))}
        </View>
        <Text variant="caption" tone="secondary">
          {t('coach.disclaimer')}
        </Text>
      </BottomSheet>
    </>
  );
}
