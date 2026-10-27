import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { BottomSheet, Button, Chip, ChipGroup, DateField, NumberStepper, SwitchRow, Text, TextField } from '../../components';
import { options, t } from '../../i18n';
import { space } from '../../theme';
import { toLocalDate } from '../common/format';
import type { Exam, ExamInput } from './api';

const KINDS: Exam['kind'][] = ['regular', 'regular', 'regular', 'recuperacao', 'regular'];

/** S-OBJ-05 Adicionar prova: subject, date, time or "Horário a definir", kind, weight (GOL-02.1). */
export function ExamSheet({
  visible,
  onClose,
  onSave,
  subjects,
  initial,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (input: ExamInput) => Promise<void>;
  subjects: { id: string; name: string }[];
  initial?: Exam | null;
}) {
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<Date | null>(null);
  const [tbd, setTbd] = useState(false);
  const [kindIdx, setKindIdx] = useState(0);
  const [weight, setWeight] = useState(1);
  const [teacher, setTeacher] = useState('');
  const [busy, setBusy] = useState(false);
  const kindLabels = options('exam.kinds');

  useEffect(() => {
    if (!visible) return;
    setSubjectId(initial?.subject_id ?? subjects[0]?.id ?? null);
    setDate(initial ? new Date(`${initial.local_date}T12:00:00`) : null);
    setTime(initial?.starts_at ? new Date(initial.starts_at) : null);
    setTbd(!!initial && !initial.starts_at);
    setKindIdx(initial?.kind === 'recuperacao' ? 3 : 0);
    setWeight(initial?.weight ?? 1);
    setTeacher(initial?.teacher_name ?? '');
  }, [visible, initial, subjects]);

  const save = async () => {
    if (!date) return;
    setBusy(true);
    try {
      let startsAt: string | null = null;
      if (!tbd && time) {
        const d = new Date(date);
        d.setHours(time.getHours(), time.getMinutes(), 0, 0);
        startsAt = d.toISOString();
      }
      const subject = subjects.find((s) => s.id === subjectId);
      await onSave({
        subject_id: subjectId,
        title: `${kindLabels[kindIdx] ?? 'Prova'} de ${subject?.name ?? ''}`.trim(),
        local_date: toLocalDate(date),
        starts_at: startsAt,
        kind: KINDS[kindIdx] ?? 'regular',
        weight,
        teacher_name: teacher.trim() || null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={initial ? t('exam.edit') : t('exam.add')} footer={<Button label={t('global.save')} loading={busy} disabled={!date || !subjectId || (!tbd && !time)} onPress={save} />}>
      <Text variant="label">{t('exam.subject')}</Text>
      <ChipGroup>
        {subjects.map((s) => (
          <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => setSubjectId(s.id)} />
        ))}
      </ChipGroup>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <DateField label={t('exam.date')} value={date} onChange={setDate} minimumDate={new Date()} />
        {!tbd ? <DateField label={t('exam.time')} mode="time" value={time} onChange={setTime} /> : null}
      </View>
      <SwitchRow label={t('exam.time_tbd')} value={tbd} onChange={setTbd} />
      <Text variant="label">{t('exam.kind')}</Text>
      <ChipGroup>
        {kindLabels.map((k, i) => (
          <Chip key={k} label={k} selected={kindIdx === i} onPress={() => setKindIdx(i)} />
        ))}
      </ChipGroup>
      <NumberStepper label={t('exam.weight')} value={weight} onChange={setWeight} min={0.5} max={10} step={0.5} format={(v) => String(v).replace('.', ',')} />
      <TextField label={t('exam.teacher')} value={teacher} onChangeText={setTeacher} />
    </BottomSheet>
  );
}
