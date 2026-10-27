import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../../api/functions';
import { uploadFile } from '../../../api/storage';
import { ActionBar, Banner, Button, Card, ListItem, Row, Screen, Text, useOnline, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { rpc } from '../../../features/common/query';
import { weekdayDate } from '../../../features/common/format';
import { useInvalidateGoal } from '../../../features/goals/api';
import { startScheduleImport, useScheduleImport } from '../../../features/prova/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';

/** S-OBJ-16 Importar calendário de provas (ING-07): photo → extracted tests (draft) → confirm. */
export default function ImportSchedule() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { userId } = useSession();
  const subjects = useSubjects();
  const online = useOnline();
  const overlay = useOverlay();
  const invalidate = useInvalidateGoal();
  const [importId, setImportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imp = useScheduleImport(importId);

  const pick = async (camera: boolean) => {
    const res = camera ? await ImagePicker.launchCameraAsync({ quality: 0.8, mediaTypes: ['images'] }) : await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ['images'] });
    const subject = subjects.data?.[0];
    if (res.canceled || !res.assets[0] || !subject) return;
    setBusy(true);
    try {
      const id = uuidv7();
      const path = `${userId}/${id}/1.jpg`;
      await uploadFile({ bucket: 'photos', path, uri: res.assets[0].uri, contentType: 'image/jpeg' });
      const doc = await callFunction<{ subject_id: string; image_paths: string[]; kind: string }, { document_id: string }>('upload-photos', { subject_id: subject.id, image_paths: [path], kind: 'other' }, { idempotencyKey: id });
      const r = await startScheduleImport(doc.document_id);
      setImportId(r.schedule_import_id);
    } catch {
      overlay.snack(t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  const extracted = imp.data?.extracted ?? null;
  return (
    <Screen
      title={t('schedule_import.title')}
      footer={
        <ActionBar>
          {extracted?.length ? (
            <Button
              label={t('schedule_import.confirm')}
              loading={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await rpc('apply_schedule_import', { schedule_import_id: importId, goal_id: goalId });
                  invalidate(goalId);
                  router.replace(`/goal/${goalId}/exams`);
                } catch {
                  overlay.snack(t('error.generic'));
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : (
            <Row>
              <Button style={{ flex: 1 }} icon="camera-outline" label={t('scope.photo')} disabled={!online || busy} loading={busy} onPress={() => pick(true)} />
              <Button style={{ flex: 1 }} variant="secondary" icon="images-outline" label={t('scope.gallery')} disabled={!online || busy} onPress={() => pick(false)} />
            </Row>
          )}
        </ActionBar>
      }
    >
      <Text tone="secondary">{t('schedule_import.hint')}</Text>
      {importId && !extracted ? <Banner kind="info" icon="hourglass-outline" message={t('schedule_import.extracting')} /> : null}
      {extracted ? (
        <>
          <Text variant="heading">{t('schedule_import.review')}</Text>
          <Banner kind={extracted.length ? 'info' : 'warning'} message={extracted.length ? t('schedule_import.found', { n: extracted.length }) : t('schedule_import.none')} />
          {extracted.map((e, i) => (
            <Card key={i}>
              <ListItem title={`${e.subject_name} — ${e.title}`} subtitle={weekdayDate(e.local_date)} />
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
