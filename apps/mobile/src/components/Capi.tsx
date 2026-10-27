// Capi, the capybara mascot (MOT-03, spec 13 §5.2). Drawn in SVG from the shared stage, mood and accessory
// rules. Moods are only ever positive or calm (MOT-03.3): curiosa, focada, comemorando, descansando, sonolenta.
import type { CapiAccessory, CapiMood, CapiStage } from '@studify/shared';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { t } from '../i18n';

const FUR = '#B07D4B';
const FUR_DARK = '#8C5E33';
const BODY = '#A0703F';
const INK = '#2B1D12';

/** Smaller and rounder when young; the wise stage gets grey brows and whiskers. */
const STAGE_SCALE: Record<CapiStage, number> = { filhote: 0.78, jovem: 0.9, adulta: 1, sabia: 1 };

function Eye({ mood, big }: { mood: CapiMood; big: boolean }) {
  const r = big ? 3.8 : 3.2;
  switch (mood) {
    case 'celebrating':
      return <Path d="M26.5 43 Q30 38.5 33.5 43" stroke={INK} strokeWidth={2.2} fill="none" strokeLinecap="round" />;
    case 'resting':
    case 'sleepy':
      return <Path d="M26.5 41.5 Q30 45 33.5 41.5" stroke={INK} strokeWidth={2.2} fill="none" strokeLinecap="round" />;
    case 'focused':
      return (
        <G>
          <Ellipse cx={30} cy={42.5} rx={r} ry={r * 0.7} fill={INK} />
          <Line x1={26} y1={37.5} x2={34} y2={38.8} stroke={INK} strokeWidth={1.8} strokeLinecap="round" />
        </G>
      );
    default:
      return (
        <G>
          <Circle cx={30} cy={42} r={r} fill={INK} />
          <Circle cx={31.2} cy={40.8} r={r * 0.32} fill="#FFFFFF" />
        </G>
      );
  }
}

function Hat({ id }: { id: string }) {
  switch (id) {
    case 'bone':
      return (
        <G>
          <Path d="M17 33 Q20 20 36 20 Q50 20 52 32 Z" fill="#E85D4A" />
          <Rect x={6} y={30} width={18} height={4.5} rx={2.2} fill="#C2412F" />
        </G>
      );
    case 'chapeu_formatura':
      return (
        <G>
          <Rect x={24} y={22} width={22} height={8} rx={2} fill="#1F2937" />
          <Polygon points="12,22 35,14 58,22 35,30" fill="#111827" />
          <Line x1={35} y1={22} x2={54} y2={28} stroke="#F5C542" strokeWidth={1.4} />
          <Circle cx={54} cy={30} r={1.8} fill="#F5C542" />
        </G>
      );
    case 'coroa_folhas':
      return (
        <G>
          {[16, 24, 32, 40, 48].map((x, i) => (
            <Ellipse key={x} cx={x} cy={i % 2 ? 26 : 27.5} rx={4.2} ry={2.4} fill={i % 2 ? '#3F9B57' : '#2E7D46'} rotation={i % 2 ? -25 : 25} origin={`${x}, 27`} />
          ))}
        </G>
      );
    case 'gorro_chefao':
      return (
        <G>
          <Path d="M15 34 Q17 16 35 16 Q53 16 54 34 Z" fill="#7A4FD0" />
          <Rect x={14} y={30} width={41} height={5} rx={2.5} fill="#5B36A8" />
          <Circle cx={35} cy={14} r={3.5} fill="#F5C542" />
        </G>
      );
    default:
      return null;
  }
}

function Glasses({ id }: { id: string }) {
  switch (id) {
    case 'oculos_sol':
      return (
        <G>
          <Ellipse cx={30} cy={42} rx={6.5} ry={5} fill="#111827" opacity={0.92} />
          <Line x1={36.5} y1={41} x2={46} y2={36} stroke="#111827" strokeWidth={1.6} />
        </G>
      );
    case 'oculos_redondos':
      return (
        <G>
          <Circle cx={30} cy={42} r={6.5} stroke="#C9A227" strokeWidth={1.8} fill="none" />
          <Line x1={36.5} y1={41} x2={46} y2={36} stroke="#C9A227" strokeWidth={1.4} />
        </G>
      );
    case 'oculos':
      return (
        <G>
          <Rect x={23.5} y={37} width={13} height={10} rx={3} stroke="#374151" strokeWidth={1.8} fill="none" />
          <Line x1={36.5} y1={41} x2={46} y2={36} stroke="#374151" strokeWidth={1.4} />
        </G>
      );
    default:
      return null;
  }
}

function Scarf({ color }: { color: string }) {
  return (
    <G>
      <Path d="M40 54 Q50 60 60 54 L61 60 Q50 66 39 60 Z" fill={color} />
      <Path d="M52 61 L56 75 L50 75 L48 62 Z" fill={color} />
    </G>
  );
}

function MoodExtras({ mood }: { mood: CapiMood }) {
  switch (mood) {
    case 'celebrating':
      return (
        <G>
          <Rect x={70} y={14} width={4} height={4} fill="#F5C542" rotation={20} origin="72, 16" />
          <Rect x={82} y={26} width={4} height={4} fill="#E85D4A" rotation={-15} origin="84, 28" />
          <Circle cx={64} cy={26} r={2} fill="#4F46E5" />
          <Circle cx={88} cy={12} r={2} fill="#2E9E5B" />
        </G>
      );
    case 'sleepy':
      return (
        <G>
          <SvgText x={62} y={26} fontSize={9} fontWeight="700" fill="#6B7280">
            z
          </SvgText>
          <SvgText x={70} y={18} fontSize={12} fontWeight="700" fill="#6B7280">
            Z
          </SvgText>
        </G>
      );
    case 'curious':
      return (
        <SvgText x={64} y={28} fontSize={14} fontWeight="700" fill="#4F46E5">
          ?
        </SvgText>
      );
    case 'focused':
      return (
        <G>
          <Rect x={56} y={66} width={26} height={14} rx={2} fill="#4F46E5" />
          <Line x1={69} y1={66} x2={69} y2={80} stroke="#C7D2FE" strokeWidth={1.4} />
        </G>
      );
    case 'resting':
      return <Ellipse cx={52} cy={90} rx={38} ry={5} fill="#E5E7EB" />;
  }
}

export interface CapiProps {
  stage: CapiStage;
  mood: CapiMood;
  accessories?: readonly CapiAccessory[];
  size?: number;
}

export function Capi({ stage, mood, accessories = [], size = 72 }: CapiProps) {
  const s = STAGE_SCALE[stage];
  const hat = accessories.find((a) => a.slot === 'hat');
  const glasses = accessories.find((a) => a.slot === 'glasses');
  const scarf = accessories.find((a) => a.slot === 'scarf');
  const lying = mood === 'resting' || mood === 'sleepy';
  const label = t('capi.a11y', { stage: t(`capi.stage.${stage}`), mood: t(`capi.mood.${mood}`) });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <MoodExtras mood={mood} />
        <G transform={`translate(${50 - 50 * s} ${(100 - 100 * s) * 0.9 + (lying ? 6 : 0)}) scale(${s})`}>
          {/* legs */}
          {lying ? null : (
            <G>
              <Rect x={30} y={78} width={9} height={12} rx={4} fill={FUR_DARK} />
              <Rect x={66} y={78} width={9} height={12} rx={4} fill={FUR_DARK} />
            </G>
          )}
          {/* body */}
          <Ellipse cx={56} cy={68} rx={34} ry={lying ? 19 : 22} fill={BODY} />
          {/* head */}
          <Rect x={14} y={28} width={44} height={34} rx={16} fill={FUR} />
          <Ellipse cx={49} cy={30} rx={5} ry={4} fill={FUR_DARK} />
          {/* snout */}
          <Rect x={8} y={42} width={24} height={18} rx={9} fill={FUR_DARK} />
          <Ellipse cx={13} cy={48} rx={1.6} ry={1.1} fill={INK} />
          <Ellipse cx={19} cy={48} rx={1.6} ry={1.1} fill={INK} />
          <Path d={mood === 'celebrating' ? 'M12 54 Q17 59 22 54' : 'M13 55 Q17 57.5 21 55'} stroke={INK} strokeWidth={1.6} fill={mood === 'celebrating' ? '#7F1D1D' : 'none'} strokeLinecap="round" />
          <Circle cx={38} cy={50} r={3.2} fill="#F28C8C" opacity={0.45} />
          <Eye mood={mood} big={stage === 'filhote'} />
          {stage === 'sabia' ? (
            <G>
              <Path d="M25 36 Q30 33 35 36" stroke="#E5E7EB" strokeWidth={2.4} fill="none" strokeLinecap="round" />
              <Line x1={9} y1={52} x2={2} y2={50} stroke="#E5E7EB" strokeWidth={1} />
              <Line x1={9} y1={54} x2={2} y2={55} stroke="#E5E7EB" strokeWidth={1} />
            </G>
          ) : null}
          {scarf?.color ? <Scarf color={scarf.color} /> : null}
          {glasses ? <Glasses id={glasses.id} /> : null}
          {hat ? <Hat id={hat.id} /> : null}
        </G>
      </Svg>
    </View>
  );
}
