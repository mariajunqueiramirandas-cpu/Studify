import { parseGradingFormula, requiredGrade, formatGradeBr, type GradeComponent, type RequiredGradeResult } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, Chip, ChipGroup, NumberStepper, RichText, Row, Screen, Section, Text, TextField, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { saveGradeComponent, useGoal, useGoalExams, useGradingData, type GradeComponentRow } from '../../../features/goals/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { space } from '../../../theme';
import { messageFor } from '../../../api/messages';

/** S-OBJ-13 Quanto preciso tirar? — components, grades, required grade per test (GOL-06). */
export default function Grades() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { userId } = useSession();
  const goal = useGoal(goalId);
  const exams = useGoalExams(goalId);
  const subjects = useSubjects();
  const year = goal.data?.school_year ?? new Date().getFullYear();
  const term = goal.data?.term_index ?? 1;
  const data = useGradingData(year);
  const overlay = useOverlay();
  const examSubjects = useMemo(() => [...new Set((exams.data ?? []).map((e) => e.subject_id).filter((x): x is string => !!x))], [exams.data]);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const sid = subjectId ?? examSubjects[0] ?? null;
  const [target, setTarget] = useState<number | null>(null);
  const [newName, setNewName] = useState('');

  const rule = useMemo(() => {
    const rows = data.data?.rules ?? [];
    const r = rows.find((x) => x.subject_id === sid) ?? rows.find((x) => x.subject_id === null);
    if (!r) return null;
    const parsed = parseGradingFormula(r.formula);
    return parsed.ok ? parsed.formula : null;
  }, [data.data, sid]);

  const comps = (data.data?.comps ?? []).filter((c) => c.subject_id === sid);
  const termComps = comps.filter((c) => c.term_index === term);
  const result: RequiredGradeResult | null = useMemo(() => {
    if (!rule || !sid) return null;
    const list: GradeComponent[] = comps.map((c) => ({ id: c.id, termIndex: c.term_index, weight: c.weight, maxPoints: c.max_points, grade: c.grade }));
    return requiredGrade(rule, list, { level: 'term', termIndex: term, ...(target != null ? { value: target } : {}) });
  }, [rule, comps, sid, term, target]);

  const subjectName = subjects.data?.find((s) => s.id === sid)?.name ?? '';
  const fmt = (v: number) => formatGradeBr(v, rule?.grade_step ?? 0.1);
  const goalValue = target ?? rule?.passing_average ?? 6;
  const termLabel = `${term}º ${rule?.terms.label ?? t('grade.term_default')}`;

  const message = (() => {
    if (!result) return null;
    switch (result.kind) {
      case 'secured':
        return { kind: 'success' as const, text: t('grade.secured') };
      case 'required': {
        const pending = termComps.filter((c) => result.pendingIds.includes(c.id));
        if (pending.length === 1) return { kind: 'info' as const, text: t('grade.need', { grade: `**${fmt(result.value)}**`, exam: pending[0]!.name, term: termLabel, target: fmt(goalValue) }) };
        return { kind: 'info' as const, text: t('grade.need_uniform', { grade: `**${fmt(result.value)}**` }) };
      }
      case 'impossible':
        return {
          kind: 'warning' as const,
          text: result.recovery != null ? t('grade.impossible', { max: fmt(rule!.scale_max), target: fmt(goalValue), rec: fmt(result.recovery) }) : t('grade.impossible_no_rec', { max: fmt(rule!.scale_max), target: fmt(goalValue) }),
        };
      default:
        return { kind: 'neutral' as const, text: t('grade.rules_missing') };
    }
  })();

  const update = async (c: GradeComponentRow, patch: Partial<GradeComponentRow>) => {
    await saveGradeComponent({ ...c, ...patch }).catch((e: unknown) => overlay.snack(messageFor(e)));
    void data.refetch();
  };

  return (
    <Screen title={t('grade.title')} onRefresh={data.refetch} refreshing={data.isRefetching}>
      <ChipGroup>
        {examSubjects.map((id) => (
          <Chip key={id} label={subjects.data?.find((s) => s.id === id)?.name ?? '…'} selected={sid === id} onPress={() => setSubjectId(id)} />
        ))}
      </ChipGroup>
      {!rule ? (
        <Card tone="soft">
          <Text>{t('grade.rules_missing')}</Text>
          <Button label={t('grade.configure')} onPress={() => router.push(`/goal/${goalId}/rules`)} />
        </Card>
      ) : (
        <>
          {message ? <Banner kind={message.kind} message={message.text} /> : null}
          <NumberStepper label={t('grade.target')} value={goalValue} onChange={setTarget} min={0} max={rule.scale_max} step={rule.grade_step >= 0.5 ? rule.grade_step : 0.5} format={fmt} />
          <Section title={t('grade.components', { term: termLabel })} action={<Button compact variant="text" label={t('rules.title')} onPress={() => router.push(`/goal/${goalId}/rules`)} />}>
            {termComps.map((c) => (
              <Card key={c.id}>
                <Row>
                  <View style={{ flex: 1 }}>
                    <Text variant="label">{c.name}</Text>
                    <Text variant="bodySmall" tone="secondary">
                      {t('exam.weight')} {c.weight ?? 1}
                    </Text>
                  </View>
                  <View style={{ width: 96 }}>
                    <TextField
                      placeholder={t('grade.pending')}
                      defaultValue={c.grade != null ? String(c.grade).replace('.', ',') : ''}
                      keyboardType="decimal-pad"
                      accessibilityLabel={`${t('exam.grade_label')} ${c.name}`}
                      onEndEditing={(e) => {
                        const v = e.nativeEvent.text.trim();
                        void update(c, { grade: v ? Number(v.replace(',', '.')) : null });
                      }}
                    />
                  </View>
                </Row>
              </Card>
            ))}
            <Row>
              <View style={{ flex: 1 }}>
                <TextField placeholder="Ex.: P2, Trabalho" value={newName} onChangeText={setNewName} accessibilityLabel={t('rules.component_name')} />
              </View>
              <Button
                compact
                variant="tonal"
                label="+"
                accessibilityLabel={t('rules.add_component')}
                disabled={!newName.trim() || !sid}
                onPress={async () => {
                  await saveGradeComponent({ user_id: userId!, subject_id: sid!, school_year: year, term_index: term, name: newName.trim(), weight: 1, position: termComps.length });
                  setNewName('');
                  void data.refetch();
                }}
              />
            </Row>
          </Section>
          <RichText variant="bodySmall" tone="secondary">
            {t('grade.never_shared')}
          </RichText>
          <Text variant="bodySmall" tone="secondary">
            {subjectName}
          </Text>
        </>
      )}
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
