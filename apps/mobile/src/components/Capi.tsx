// Capi, the capybara mascot (MOT-03, spec 13 §5.2): one illustration per stage and mood, with the unlocked
// accessories drawn on top from each pose's anchors. Moods are only ever positive or calm (MOT-03.3): curiosa,
// focada, comemorando, descansando, sonolenta.
import type { CapiAccessory, CapiMood, CapiStage } from '@studify/shared';
import { createContext, useContext } from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { t } from '../i18n';
import { accessoryArt, CAPI_POSES } from './capi-anchors';

const ART: Record<`${CapiStage}_${CapiMood}`, ImageSourcePropType> = {
  filhote_celebrating: require('../../assets/capi/filhote_celebrating.webp'),
  filhote_curious: require('../../assets/capi/filhote_curious.webp'),
  filhote_focused: require('../../assets/capi/filhote_focused.webp'),
  filhote_resting: require('../../assets/capi/filhote_resting.webp'),
  filhote_sleepy: require('../../assets/capi/filhote_sleepy.webp'),
  jovem_celebrating: require('../../assets/capi/jovem_celebrating.webp'),
  jovem_curious: require('../../assets/capi/jovem_curious.webp'),
  jovem_focused: require('../../assets/capi/jovem_focused.webp'),
  jovem_resting: require('../../assets/capi/jovem_resting.webp'),
  jovem_sleepy: require('../../assets/capi/jovem_sleepy.webp'),
  adulta_celebrating: require('../../assets/capi/adulta_celebrating.webp'),
  adulta_curious: require('../../assets/capi/adulta_curious.webp'),
  adulta_focused: require('../../assets/capi/adulta_focused.webp'),
  adulta_resting: require('../../assets/capi/adulta_resting.webp'),
  adulta_sleepy: require('../../assets/capi/adulta_sleepy.webp'),
  sabia_celebrating: require('../../assets/capi/sabia_celebrating.webp'),
  sabia_curious: require('../../assets/capi/sabia_curious.webp'),
  sabia_focused: require('../../assets/capi/sabia_focused.webp'),
  sabia_resting: require('../../assets/capi/sabia_resting.webp'),
  sabia_sleepy: require('../../assets/capi/sabia_sleepy.webp'),
};

/** Capi scenes for empty, first-run and offline moments. */
export const CAPI_SCENES = {
  empty: require('../../assets/capi/scene_empty.webp') as ImageSourcePropType,
  hello: require('../../assets/capi/scene_hello.webp') as ImageSourcePropType,
  offline: require('../../assets/capi/scene_offline.webp') as ImageSourcePropType,
};

/** False when the student hid Capi (Perfil → Capi); empty and offline states then fall back to an icon. */
export const MascotVisibleContext = createContext(true);
export const useMascotVisible = () => useContext(MascotVisibleContext);

export interface CapiProps {
  stage: CapiStage;
  mood: CapiMood;
  accessories?: readonly CapiAccessory[];
  size?: number;
}

export function Capi({ stage, mood, accessories = [], size = 72 }: CapiProps) {
  const key = `${stage}_${mood}` as const;
  const layers = accessories.length ? accessoryArt(CAPI_POSES[key], accessories) : [];
  const label = t('capi.a11y', { stage: t(`capi.stage.${stage}`), mood: t(`capi.mood.${mood}`) });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      <Image source={ART[key]} style={{ width: size, height: size }} resizeMode="contain" fadeDuration={0} />
      {layers.length ? (
        <Svg width={size} height={size} viewBox="0 0 1024 1024" style={{ position: 'absolute', left: 0, top: 0 }}>
          {layers.map((layer, i) => (
            <G key={i} transform={layer.transform}>
              {layer.shapes.map((s, j) => (
                <Path key={j} d={s.d} fill={s.fill ?? 'none'} stroke={s.stroke} strokeWidth={s.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </G>
          ))}
        </Svg>
      ) : null}
    </View>
  );
}

/** A Capi scene (empty list, first run, offline) at a given width. */
export function CapiScene({ scene, size = 160 }: { scene: keyof typeof CAPI_SCENES; size?: number }) {
  return <Image source={CAPI_SCENES[scene]} style={{ width: size, height: size }} resizeMode="contain" fadeDuration={0} accessibilityIgnoresInvertColors importantForAccessibility="no" />;
}
