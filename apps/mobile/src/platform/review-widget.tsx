// Home-screen "Revisão rápida" widget (MEM-04; 2×2 and 4×2 via resize). A headless task: reads the queue
// (queue_cache, maintained by recordReview) from the same SQLite file, and rates through the same
// recordReview as the app. No network calls here; sync happens on the next app or background run.
import { asc, eq, lte } from 'drizzle-orm';
import { FlexWidget, TextWidget, registerWidgetTaskHandler, requestWidgetUpdate, type WidgetInfo, type WidgetTaskHandlerProps } from 'react-native-android-widget';
import { Platform } from 'react-native';
import { renderCloze } from '../components/Flashcard';
import { ensureAppDatabase, type AppDb } from '../db/client';
import { recordReview } from '../db/hooks/review';
import { cards, queueCache } from '../db/schema';
import { notifyLocalWrite } from '../db/sync/bus';
import { getKv } from '../lib/kv';
import type { ReviewWidgetController } from './types';

export const REVIEW_WIDGET_NAME = 'ReviewWidget';
const REVEALED_KEY = 'widget.revealed.cardId';

type WidgetCard =
  | { cardId: string; eligible: true; front: string; back: string }
  | { cardId: string; eligible: false };

const FRONT_MAX = 140;
const BACK_MAX = 200;
const COMPACT_MAX_DP = 200; // 2×2 is ~110–180 dp wide, 4×2 is ≥ 250 dp.

/** Strips the Markdown markers that do not render in a RemoteViews text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** MEM-04.2: short text only — no LaTeX, no images (they cannot render in RemoteViews). */
export function widgetFaces(card: { type: string; front: string; back: string; clozeIndex: number | null; hasMath: boolean | null; media: unknown }) {
  const raw = `${card.front}\n${card.back}`;
  if (card.hasMath || card.media || /\$|!\[/.test(raw)) return null;
  const cloze = card.type === 'cloze';
  const front = plainText(cloze ? renderCloze(card.front, 'front', card.clozeIndex) : card.front);
  const back = plainText(cloze ? renderCloze(card.front, 'back', card.clozeIndex) : card.back);
  return front.length <= FRONT_MAX && back.length <= BACK_MAX ? { front, back } : null;
}

function nextCard(db: AppDb, now = Date.now()): WidgetCard | null {
  const row = db
    .select({ cardId: queueCache.cardId, type: cards.type, front: cards.front, back: cards.back, clozeIndex: cards.clozeIndex, hasMath: cards.hasMath, media: cards.media })
    .from(queueCache)
    .innerJoin(cards, eq(cards.id, queueCache.cardId))
    .where(lte(queueCache.effectiveDue, now))
    .orderBy(asc(queueCache.effectiveDue))
    .limit(1)
    .get();
  if (!row) return null;
  const faces = widgetFaces(row);
  return faces ? { cardId: row.cardId, eligible: true, ...faces } : { cardId: row.cardId, eligible: false };
}

function revealedCardId(): string | null {
  return getKv().getString(REVEALED_KEY) ?? null;
}

type Hex = `#${string}`;

// Fixed light palette (RemoteViews cannot follow the app theme at runtime); AA contrast on white.
const C = { bg: '#FFFFFF', text: '#111827', muted: '#4B5563', primary: '#4F46E5', primarySoft: '#E0E7FF', onPrimarySoft: '#3730A3', againBg: '#FEE2E2', again: '#991B1B', goodBg: '#DCFCE7', good: '#166534' } as const;

function Button({ label, action, data, bg, color, compact }: { label: string; action: string; data: Record<string, string>; bg: Hex; color: Hex; compact: boolean }) {
  return (
    <FlexWidget
      clickAction={action}
      clickActionData={data}
      accessibilityLabel={label}
      style={{ flex: 1, height: compact ? 40 : 44, marginHorizontal: 2, backgroundColor: bg, borderRadius: 10, justifyContent: 'center', alignItems: 'center' }}
    >
      <TextWidget text={label} style={{ fontSize: 14, fontFamily: 'sans-serif-medium', color }} />
    </FlexWidget>
  );
}

/** MEM-04.1: front → "Mostrar" → back → Errei / Lembrei. Same view in 2×2 (compact) and 4×2. */
export function ReviewWidgetView({ card, revealed, compact = false }: { card: WidgetCard | null; revealed: boolean; compact?: boolean }) {
  const frame = { height: 'match_parent' as const, width: 'match_parent' as const, padding: compact ? 10 : 12, backgroundColor: C.bg, borderRadius: 16, flexDirection: 'column' as const };
  const header = <TextWidget text="Revisão rápida" style={{ fontSize: 12, color: C.muted }} />;
  if (!card) {
    return (
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: 'studify://today' }} style={{ ...frame, justifyContent: 'center', alignItems: 'center' }}>
        <TextWidget text="Tudo revisado por hoje ✨" maxLines={3} style={{ fontSize: compact ? 14 : 16, color: C.text, textAlign: 'center' }} />
      </FlexWidget>
    );
  }
  if (!card.eligible) {
    return (
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: 'studify://practice/review' }} style={{ ...frame, justifyContent: 'space-between' }}>
        {header}
        <TextWidget text="Próximo cartão tem fórmula/imagem — abrir no app" maxLines={4} style={{ fontSize: compact ? 13 : 15, color: C.text }} />
        <TextWidget text="Abrir revisão" style={{ fontSize: 14, fontFamily: 'sans-serif-medium', color: C.primary }} />
      </FlexWidget>
    );
  }
  return (
    <FlexWidget style={{ ...frame, justifyContent: 'space-between' }}>
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: 'studify://practice/review' }} style={{ width: 'match_parent', flex: 1, flexDirection: 'column' }}>
        {compact ? null : header}
        <TextWidget
          text={revealed ? card.back : card.front}
          maxLines={compact ? 4 : 3}
          truncate="END"
          style={{ fontSize: compact ? 14 : 15, color: C.text, marginTop: compact ? 0 : 4 }}
        />
      </FlexWidget>
      {revealed ? (
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
          <Button label="Errei" action="RATE" data={{ cardId: card.cardId, rating: 'again' }} bg={C.againBg} color={C.again} compact={compact} />
          <Button label="Lembrei" action="RATE" data={{ cardId: card.cardId, rating: 'good' }} bg={C.goodBg} color={C.good} compact={compact} />
        </FlexWidget>
      ) : (
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent' }}>
          <Button label="Mostrar" action="REVEAL" data={{ cardId: card.cardId }} bg={C.primarySoft} color={C.onPrimarySoft} compact={compact} />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}

type Render = WidgetTaskHandlerProps['renderWidget'];

function viewFor(db: AppDb, info: Pick<WidgetInfo, 'width'>) {
  const card = nextCard(db);
  const revealed = card !== null && revealedCardId() === card.cardId;
  return <ReviewWidgetView card={card} revealed={revealed} compact={info.width < COMPACT_MAX_DP} />;
}

function renderFromDatabase(db: AppDb, renderWidget: Render, info: WidgetInfo): void {
  renderWidget(viewFor(db, info));
}

/** Task handler: every widget action re-renders from the current queue. */
export async function reviewWidgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetAction, widgetInfo, clickAction, clickActionData, renderWidget } = props;
  const db = await ensureAppDatabase();

  if (widgetAction === 'WIDGET_CLICK' && clickAction === 'REVEAL') {
    const cardId = clickActionData?.['cardId'];
    if (typeof cardId === 'string') getKv().set(REVEALED_KEY, cardId);
  } else if (widgetAction === 'WIDGET_CLICK' && clickAction === 'RATE') {
    const cardId = clickActionData?.['cardId'];
    const rating = clickActionData?.['rating'] === 'again' ? 1 : 3;
    if (typeof cardId === 'string') {
      await recordReview(db, { cardId, rating, source: 'widget' });
      getKv().remove(REVEALED_KEY);
      notifyLocalWrite('widget');
    }
  }

  if (widgetAction === 'WIDGET_DELETED') return;
  renderFromDatabase(db, renderWidget, widgetInfo);
}

/** Must run at module load of the app entry, before the first widget action (see the report). */
export function registerReviewWidgetTaskHandler(): void {
  if (Platform.OS !== 'android') return;
  registerWidgetTaskHandler(reviewWidgetTaskHandler);
}

export const reviewWidget: ReviewWidgetController = {
  async refresh() {
    if (Platform.OS !== 'android') return;
    const db = await ensureAppDatabase();
    await requestWidgetUpdate({
      widgetName: REVIEW_WIDGET_NAME,
      renderWidget: (info) => viewFor(db, info),
      widgetNotFound: () => undefined,
    });
  },
};
