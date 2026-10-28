import type { OcclusionMask, OcclusionMode } from '@studify/shared';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { PanResponder, View, type LayoutRectangle } from 'react-native';
import { ActionBar, Banner, Button, Card, EmptyState, IconButton, OcclusionEditorImage, Row, Screen, SegmentedControl, SkeletonList, SwitchRow, Text, TextField, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { createOcclusionCards, prepareOcclusionImage, type OcclusionSource } from '../../features/learn/occlusion';
import { useSubject } from '../../features/subjects/api';
import { options, t } from '../../i18n';
import { space, useTheme } from '../../theme';
import { messageFor } from '../../api/messages';

const STEP = 0.02;

/**
 * S-MEM-03 image-occlusion editor (MEM-03.1–03.7): pick a photo or figure, start from the masks ML Kit
 * suggests, toggle, draw, resize and label them, choose Esconder todos / Esconder um, save one card per mask.
 */
export default function NewOcclusion() {
  const params = useLocalSearchParams<{ subjectId: string; nodeId: string; uri?: string; width?: string; height?: string }>();
  const { userId } = useSession();
  const overlay = useOverlay();
  const { colors: c } = useTheme();
  const subject = useSubject(params.subjectId);
  const [image, setImage] = useState<OcclusionSource | null>(null);
  const [masks, setMasks] = useState<OcclusionMask[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<OcclusionMode>('hide_all');
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [preparing, setPreparing] = useState(!!params.uri);
  const [saving, setSaving] = useState(false);
  const [share, setShare] = useState(false);
  const [box, setBox] = useState<LayoutRectangle | null>(null);
  const modeLabels = options('occlusion.modes');
  const sharedSubject = !!subject.data?.owner_class_group_id;

  const load = async (source: OcclusionSource) => {
    try {
      const prepared = await prepareOcclusionImage(source);
      setImage(prepared);
      setMasks(prepared.masks);
    } catch {
      overlay.snack(t('cam.prepare_failed'));
    } finally {
      setPreparing(false);
    }
  };

  const pick = async (camera: boolean) => {
    setPreparing(true);
    const res = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
    if (!res.canceled && res.assets[0]) await load({ uri: res.assets[0].uri, width: res.assets[0].width, height: res.assets[0].height });
    else setPreparing(false);
  };

  // A figure or PDF crop handed over by another screen (MEM-03.1) is loaded once.
  useEffect(() => {
    if (!params.uri) return undefined;
    let alive = true;
    prepareOcclusionImage({ uri: params.uri, width: Number(params.width ?? 1000), height: Number(params.height ?? 1000) })
      .then((prepared) => {
        if (!alive) return;
        setImage(prepared);
        setMasks(prepared.masks);
      })
      .catch(() => overlay.snack(t('cam.prepare_failed')))
      .finally(() => alive && setPreparing(false));
    return () => {
      alive = false;
    };
  }, [params.uri, params.width, params.height, overlay]);

  // Draw mode: drag a rectangle on the image (normalized to the image box).
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const l = box;
          if (!l) return;
          setDraft({ x: e.nativeEvent.locationX / l.width, y: e.nativeEvent.locationY / l.height, w: 0, h: 0 });
        },
        onPanResponderMove: (_e, g) => {
          const l = box;
          if (!l) return;
          setDraft((d) => (d ? { ...d, w: g.dx / l.width, h: g.dy / l.height } : d));
        },
        onPanResponderRelease: () => {
          setDraft((d) => {
            if (d) {
              const box = { x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) };
              if (box.w > 0.01 && box.h > 0.01) {
                const id = `m${Date.now().toString(36)}`;
                setMasks((all) => [...all, { id, label: '', ...box }]);
                setSelected(id);
              }
            }
            return null;
          });
          setDrawing(false);
        },
      }),
    [box],
  );

  const current = masks.find((m) => m.id === selected) ?? null;
  const update = (patch: Partial<OcclusionMask>) => setMasks((all) => all.map((m) => (m.id === selected ? { ...m, ...patch } : m)));
  const labeled = masks.filter((m) => m.label.trim()).length;

  const save = async () => {
    if (!image || !userId) return;
    setSaving(true);
    try {
      const n = await createOcclusionCards(userId, { subjectId: params.subjectId, nodeId: params.nodeId, image, masks: masks.map((m) => ({ ...m, label: m.label.trim() })), mode, personal: !sharedSubject || !share });
      overlay.snack(t('occlusion.saved', { n }));
      router.back();
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title={t('occlusion.title')}
      closeIcon
      onBack={() => router.back()}
      footer={
        image ? (
          <ActionBar>
            <Button label={t('occlusion.save', { n: labeled })} loading={saving} disabled={labeled === 0} onPress={() => void save()} />
          </ActionBar>
        ) : undefined
      }
    >
      {preparing ? <SkeletonList rows={2} height={160} /> : null}
      {!image && !preparing ? (
        <EmptyState icon="image-outline" message={t('occlusion.pick')} action={{ label: t('cam.shoot'), icon: 'camera-outline', onPress: () => void pick(true) }} />
      ) : null}
      {!image && !preparing ? <Button variant="text" icon="images-outline" label={t('cam.gallery')} onPress={() => void pick(false)} /> : null}
      {image ? (
        <>
          <Text variant="bodySmall" tone="secondary">
            {masks.length ? t('occlusion.suggested', { n: masks.length }) : t('occlusion.none_suggested')}
          </Text>
          <View onLayout={(e) => setBox(e.nativeEvent.layout)} {...(drawing ? pan.panHandlers : {})}>
            <OcclusionEditorImage uri={image.uri} width={image.width} height={image.height} masks={masks} selectedId={selected} onSelect={(id) => !drawing && setSelected(id)}>
              {draft ? (
                <View
                  pointerEvents="none"
                  style={{ position: 'absolute', left: `${Math.min(draft.x, draft.x + draft.w) * 100}%`, top: `${Math.min(draft.y, draft.y + draft.h) * 100}%`, width: `${Math.abs(draft.w) * 100}%`, height: `${Math.abs(draft.h) * 100}%`, borderWidth: 2, borderColor: c.primary }}
                />
              ) : null}
            </OcclusionEditorImage>
          </View>
          <Row wrap>
            <Button compact variant={drawing ? 'primary' : 'tonal'} icon="square-outline" label={drawing ? t('occlusion.drawing') : t('occlusion.draw')} onPress={() => setDrawing((v) => !v)} />
          </Row>
          {current ? (
            <Card tone="outline">
              <TextField label={t('occlusion.label')} value={current.label} onChangeText={(label) => update({ label })} placeholder={t('occlusion.label_placeholder')} />
              <Row wrap>
                <IconButton icon="remove" label={t('occlusion.narrower')} onPress={() => update({ w: Math.max(0.02, current.w - STEP) })} />
                <IconButton icon="add" label={t('occlusion.wider')} onPress={() => update({ w: Math.min(1 - current.x, current.w + STEP) })} />
                <IconButton icon="chevron-up" label={t('occlusion.shorter')} onPress={() => update({ h: Math.max(0.02, current.h - STEP) })} />
                <IconButton icon="chevron-down" label={t('occlusion.taller')} onPress={() => update({ h: Math.min(1 - current.y, current.h + STEP) })} />
                <View style={{ flex: 1 }} />
                <IconButton icon="trash-outline" label={t('occlusion.delete')} onPress={() => (setMasks((all) => all.filter((m) => m.id !== current.id)), setSelected(null))} />
              </Row>
            </Card>
          ) : (
            <Text variant="bodySmall" tone="secondary">{t('occlusion.tap_to_edit')}</Text>
          )}
          <SegmentedControl<OcclusionMode>
            label={t('occlusion.mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'hide_all', label: modeLabels[0] ?? 'Esconder todos' },
              { value: 'hide_one', label: modeLabels[1] ?? 'Esconder um' },
            ]}
          />
          {sharedSubject ? <SwitchRow label={t('occlusion.share')} hint={t('occlusion.share_hint')} value={share} onChange={setShare} /> : null}
          {masks.length > labeled ? <Banner kind="neutral" message={t('occlusion.unlabeled', { n: masks.length - labeled })} /> : null}
        </>
      ) : null}
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
