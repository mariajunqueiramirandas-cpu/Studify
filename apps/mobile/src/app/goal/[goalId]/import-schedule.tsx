import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../../api/functions';
import { uploadFile } from '../../../api/storage';
import { ActionBar, Banner, Button, Card, GenerationStatus, ListItem, Row, Screen, Text, useOnline, useOverlay } from '../../../components';
import { useJob } from '../../../api/realtime';
import { jobErrorText } from '../../../features/progress/jobs';
import { useSession } from '../../../features/auth/session';
import { rpc } from '../../../features/common/query';
import { weekdayDate } from '../../../features/common/format';
import { useInvalidateGoal } from '../../../features/goals/api';
import { startScheduleImport, useScheduleImport } from '../../../features/prova/api';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** S-OBJ-16 Importar calendário de provas (ING-07): photo → extracted tests (draft) → confirm. */
export default function ImportSchedule() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { userId } = useSession();
  const subjects = useSubjects();
  const online = useOnline();
  const overlay = useOverlay();
  const invalidate = useInvalidateGoal();
  const [importId, setImportId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Reading the photo runs on the server (ADR 0011); its job row (Realtime) says when it is over and how it went.
  const job = useJob(jobId).data;
  const reading = !!jobId && (!job || job.status === 'queued' || job.status === 'running');
  const imp = useScheduleImport(importId, reading);
  const finished = job?.status === 'succeeded';
  useEffect(() => {
    if (finished) void imp.refetch();
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setJobId(r.job_id);
    } catch (e) {
      overlay.snack(messageFor(e, t('error.generation')));
    } finally {
      setBusy(false);
    }
  };

  const extracted = finished && imp.data ? (imp.data.extracted ?? []) : null;
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
                } catch (e) {
                  overlay.snack(messageFor(e));
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
      {reading ? <GenerationStatus title={t('schedule_import.extracting')} startedAt={job?.started_at as string | undefined} queued={job?.status === 'queued'} slowAfterS={40} /> : null}
      {job && (job.status === 'failed' || job.status === 'cancelled') ? <GenerationStatus title={t('schedule_import.title')} error={jobErrorText(job)} onRetry={online ? () => void pick(true) : undefined} /> : null}
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
