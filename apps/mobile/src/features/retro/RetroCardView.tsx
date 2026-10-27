// One 9:16 story card of the Retrospectiva (MOT-04.2). Self-contained so it can be captured as an image for
// sharing (MOT-04.3): it never shows classmates' names, and grades only appear in the "grades" card.
import type { CapiAccessory, CapiStage, RetroCard } from '@studify/shared';
import { forwardRef, type ComponentRef } from 'react';
import { View } from 'react-native';
import { Capi, Text } from '../../components';
import { t } from '../../i18n';
import { radius, space } from '../../theme';

/** 700-level backgrounds: white text keeps ≥ 4.5:1 contrast on all of them. */
const BACKGROUNDS = ['#4338CA', '#0369A1', '#15803D', '#C2410C', '#BE185D', '#6D28D9', '#0E7490', '#A16207'];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n = (x: number) => x.toLocaleString('pt-BR');

function Body({ card, period }: { card: RetroCard; period: string }) {
  const big = (text: string) => (
    <Text variant="display" align="center" style={{ color: '#FFFFFF', fontSize: 56, lineHeight: 64 }}>
      {text}
    </Text>
  );
  const line = (text: string, size: 'title' | 'body' = 'body') => (
    <Text variant={size} align="center" style={{ color: '#FFFFFF' }}>
      {text}
    </Text>
  );
  switch (card.kind) {
    case 'intro':
      return (
        <>
          {line(period)}
          {line(card.title, 'title')}
          {card.subtitle ? line(card.subtitle) : null}
        </>
      );
    case 'hours':
      return (
        <>
          {line(t('retro.card.hours_top'))}
          {big(n(card.hours))}
          {line(t('retro.card.hours', { days: card.days }))}
        </>
      );
    case 'cards':
      return (
        <>
          {big(n(card.count))}
          {line(t('retro.card.cards'))}
        </>
      );
    case 'questions':
      return (
        <>
          {big(n(card.count))}
          {line(t('retro.card.questions'))}
          {card.accuracy !== null ? line(t('retro.card.accuracy', { pct: pct(card.accuracy) })) : null}
        </>
      );
    case 'best_subject':
      return (
        <>
          {line(t('retro.card.best_subject'))}
          {line(card.name, 'title')}
          {line(t('retro.card.accuracy', { pct: pct(card.accuracy) }))}
        </>
      );
    case 'most_improved':
      return (
        <>
          {line(t('retro.card.most_improved'))}
          {line(card.title, 'title')}
          {line(t('retro.card.from_to', { from: pct(card.from), to: pct(card.to) }))}
        </>
      );
    case 'streak':
      return (
        <>
          {line(t('retro.card.streak_top'))}
          {big(`${card.days} 🔥`)}
          {line(t('retro.card.streak'))}
        </>
      );
    case 'lucas':
      return (
        <>
          {line(t('retro.card.lucas'))}
          {big(String(Math.round(card.score)))}
        </>
      );
    case 'duels':
      return (
        <>
          {big(`${card.won} ⚔️`)}
          {line(t('retro.card.duels'))}
        </>
      );
    case 'calibration':
      return (
        <>
          {line(t('retro.card.calibration'))}
          {big(`+${Math.round(card.gain * 100)}`)}
          {line(t('retro.card.calibration_hint'))}
        </>
      );
    case 'grades':
      return (
        <>
          {line(t('retro.card.grades'), 'title')}
          {card.grades.slice(0, 8).map((g, i) => (
            <Text key={`${g.subject}-${i}`} align="center" style={{ color: '#FFFFFF' }}>
              {`${g.subject}: ${g.grade}`}
            </Text>
          ))}
        </>
      );
    case 'closing':
      return (
        <>
          {line(t('retro.card.closing'), 'title')}
          {line(t('retro.card.closing_hint'))}
        </>
      );
  }
}

export interface RetroCardViewProps {
  card: RetroCard;
  index: number;
  period: string;
  width: number;
  capi: { stage: CapiStage; accessories: readonly CapiAccessory[]; visible: boolean };
}

export type RetroCardRef = ComponentRef<typeof View>;

export const RetroCardView = forwardRef<RetroCardRef, RetroCardViewProps>(function RetroCardView({ card, index, period, width, capi }, ref) {
  const height = Math.round((width * 16) / 9);
  const showCapi = capi.visible && (card.kind === 'intro' || card.kind === 'closing' || card.kind === 'streak');
  return (
    <View
      ref={ref}
      collapsable={false}
      accessible
      accessibilityLabel={`${t('retro.card_label', { n: index + 1 })}`}
      style={{ width, height, borderRadius: radius.lg, backgroundColor: BACKGROUNDS[index % BACKGROUNDS.length], padding: space.xl, justifyContent: 'center', alignItems: 'center', gap: space.md, overflow: 'hidden' }}
    >
      {showCapi ? <Capi stage={capi.stage} mood={card.kind === 'intro' ? 'curious' : 'celebrating'} accessories={capi.accessories} size={120} /> : null}
      <Body card={card} period={period} />
      <View style={{ position: 'absolute', bottom: space.lg }}>
        <Text variant="caption" style={{ color: '#FFFFFF', opacity: 0.85 }}>
          Studify · {t('retro.title')}
        </Text>
      </View>
    </View>
  );
});
