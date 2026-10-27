import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { maxCapturePages, type CaptureIntent } from '@studify/shared';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActionBar, Banner, Button, EmptyState, IconButton, ListItem, ProgressBar, Row, Screen, Text, useOnline, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { createCapture } from '../../features/camera/api';
import { preparePhoto } from '../../features/camera/image';
import { options, t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

type Prepared = Awaited<ReturnType<typeof preparePhoto>>;

const INTENTS: { intent: CaptureIntent; icon: 'bulb-outline' | 'calculator-outline' | 'add-circle-outline' | 'create-outline' }[] = [
  { intent: 'explain', icon: 'bulb-outline' },
  { intent: 'solve', icon: 'calculator-outline' },
  { intent: 'add_to_subject', icon: 'add-circle-outline' },
  { intent: 'grade_answer', icon: 'create-outline' },
];

/**
 * S-CAM-01 Câmera Mágica (CAM-00): pick what to do, shoot (document frame) or import from the gallery, and every
 * photo is resized, checked for blur / dark / glare and has faces pixelated on the phone before upload.
 */
export default function CameraCapture() {
  const params = useLocalSearchParams<{ intent?: CaptureIntent; subjectId?: string; nodeId?: string; questionId?: string }>();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c } = useTheme();
  const [perm, requestPerm] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [intent, setIntent] = useState<CaptureIntent | null>(params.intent ?? null);
  const [photos, setPhotos] = useState<Prepared[]>([]);
  const [pending, setPending] = useState<Prepared | null>(null);
  const [working, setWorking] = useState(false);
  const [upload, setUpload] = useState<number | null>(null);
  const intentLabels = options('cam.intents');
  const max = intent ? maxCapturePages(intent) : 1;

  const accept = (p: Prepared) => {
    setPhotos((all) => [...all, p].slice(0, max));
    setPending(null);
    if (p.faces > 0) overlay.snack(t('cam.faces_blurred'));
  };

  const handle = async (source: { uri: string; width: number; height: number }) => {
    setWorking(true);
    try {
      const prepared = await preparePhoto(source);
      if (prepared.issues.length) setPending(prepared);
      else accept(prepared);
    } catch {
      overlay.snack(t('cam.prepare_failed'));
    } finally {
      setWorking(false);
    }
  };

  const shoot = async () => {
    const pic = await camera.current?.takePictureAsync({ quality: 0.9, exif: false });
    if (pic) await handle(pic);
  };

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsMultipleSelection: max > 1, selectionLimit: Math.max(1, max - photos.length), exif: false });
    if (res.canceled) return;
    for (const asset of res.assets) await handle({ uri: asset.uri, width: asset.width, height: asset.height });
  };

  const send = async () => {
    if (!intent || !userId || photos.length === 0) return;
    setUpload(0);
    try {
      const captureId = await createCapture(userId, { intent, photos, subjectId: params.subjectId ?? null, nodeId: params.nodeId ?? null }, setUpload);
      router.replace({ pathname: '/camera/[captureId]', params: { captureId, ...(params.questionId ? { questionId: params.questionId } : {}) } });
    } catch {
      overlay.snack(t('cam.upload_failed'));
      setUpload(null);
    }
  };

  if (!intent) {
    return (
      <Screen title={t('cam.title')} closeIcon onBack={() => router.back()}>
        <Text variant="heading">{t('cam.intent.title')}</Text>
        {INTENTS.map((x, i) => (
          <ListItem key={x.intent} icon={x.icon} title={intentLabels[i] ?? x.intent} subtitle={t(`cam.intent_hint.${x.intent}`)} onPress={() => setIntent(x.intent)} />
        ))}
        <Text variant="bodySmall" tone="secondary">{t('cam.privacy')}</Text>
      </Screen>
    );
  }

  return (
    <Screen
      title={intentLabels[INTENTS.findIndex((x) => x.intent === intent)] ?? t('cam.title')}
      closeIcon
      onBack={() => (params.intent ? router.back() : (setIntent(null), setPhotos([])))}
      footer={
        <ActionBar>
          {upload !== null ? <ProgressBar value={upload / 100} label={t('cam.uploading')} /> : null}
          <Button label={t('global.continue')} disabled={photos.length === 0 || !online || upload !== null} disabledReason={online ? undefined : t('cam.offline')} loading={upload !== null} onPress={() => void send()} />
        </ActionBar>
      }
    >
      {!online ? <Banner kind="warning" message={t('cam.offline')} /> : null}
      {pending ? (
        <View style={{ gap: space.md }}>
          <Image source={{ uri: pending.uri }} style={[styles.preview, { backgroundColor: c.surface2 }]} contentFit="contain" accessibilityLabel={t('cam.preview')} />
          {pending.issues.map((issue) => (
            <Banner key={issue} kind="warning" message={t(`cam.quality.${issue === 'tilt' ? 'skew' : issue}`)} />
          ))}
          <Row>
            <Button style={{ flex: 1 }} variant="secondary" label={t('cam.retake')} onPress={() => setPending(null)} />
            <Button style={{ flex: 1 }} label={t('cam.quality.use_anyway')} onPress={() => accept(pending)} />
          </Row>
        </View>
      ) : photos.length < max ? (
        perm?.granted ? (
          <View style={[styles.cameraWrap, { borderColor: c.border }]}>
            <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
            <View pointerEvents="none" style={[styles.frame, { borderColor: c.onPrimary }]} />
            <View style={styles.shutterRow}>
              <IconButton icon="images-outline" label={t('cam.gallery')} color={c.onPrimary} onPress={() => void pick()} />
              <Button label={working ? t('cam.preparing') : t('cam.shoot')} icon="camera" loading={working} onPress={() => void shoot()} />
            </View>
          </View>
        ) : (
          <EmptyState
            icon="camera-outline"
            message={t('perm.camera')}
            action={{ label: perm?.canAskAgain === false ? t('notif.system_settings') : t('cam.allow'), onPress: () => void requestPerm() }}
          />
        )
      ) : null}
      {!perm?.granted && !pending ? <Button variant="text" icon="images-outline" label={t('cam.gallery')} onPress={() => void pick()} /> : null}
      {photos.length ? (
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('cam.pages', { n: photos.length, max })}</Text>
          <ScrollView horizontal contentContainerStyle={{ gap: space.sm }}>
            {photos.map((p, i) => (
              <View key={p.uri}>
                <Image source={{ uri: p.uri }} style={[styles.thumb, { backgroundColor: c.surface2 }]} contentFit="cover" accessibilityLabel={t('cam.page_n', { n: i + 1 })} />
                <IconButton icon="close-circle" label={t('cam.remove_page', { n: i + 1 })} size={20} onPress={() => setPhotos((all) => all.filter((x) => x !== p))} />
              </View>
            ))}
          </ScrollView>
        </View>
      ) : (
        <Text variant="bodySmall" tone="secondary">{t(`cam.tip.${intent}`)}</Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cameraWrap: { height: 460, borderRadius: radius.lg, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  frame: { position: 'absolute', left: '8%', right: '8%', top: '8%', bottom: '22%', borderWidth: 2, borderRadius: radius.md, borderStyle: 'dashed' },
  shutterRow: { position: 'absolute', left: 0, right: 0, bottom: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl },
  preview: { width: '100%', height: 380, borderRadius: radius.lg },
  thumb: { width: 72, height: 96, borderRadius: radius.sm },
});
