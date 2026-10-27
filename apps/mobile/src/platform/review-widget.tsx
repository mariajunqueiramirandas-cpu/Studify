// Home-screen "Revisão rápida" widget (mobile-app.md §6.1). A headless task: reads the queue
// (queue_cache, maintained by recordReview) from the same SQLite file, and rates through the same
// recordReview as the app. No network calls here; sync happens on the next app or background run.
import { asc, eq } from 'drizzle-orm';
import { FlexWidget, TextWidget, registerWidgetTaskHandler, requestWidgetUpdate, type WidgetTaskHandlerProps } from 'react-native-android-widget';
import { Platform } from 'react-native';
import { ensureAppDatabase, type AppDb } from '../db/client';
import { recordReview } from '../db/hooks/review';
import { cards, queueCache } from '../db/schema';
import { notifyLocalWrite } from '../db/sync/bus';
import { getKv } from '../lib/kv';
import type { ReviewWidgetController } from './types';

export const REVIEW_WIDGET_NAME = 'ReviewWidget';
const REVEALED_KEY = 'widget.revealed.cardId';

interface WidgetCard {
  cardId: string;
  front: string;
  back: string;
}

/** Strips the Markdown/KaTeX markers that do not render in a RemoteViews text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, '[fórmula]')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nextCard(db: AppDb): WidgetCard | null {
  const row = db
    .select({ cardId: queueCache.cardId, front: cards.front, back: cards.back })
    .from(queueCache)
    .innerJoin(cards, eq(cards.id, queueCache.cardId))
    .orderBy(asc(queueCache.effectiveDue))
    .limit(1)
    .get();
  return row ? { cardId: row.cardId, front: plainText(row.front), back: plainText(row.back) } : null;
}

function revealedCardId(): string | null {
  return getKv().getString(REVEALED_KEY) ?? null;
}

function ReviewWidgetView({ card, revealed }: { card: WidgetCard | null; revealed: boolean }) {
  if (!card) {
    return (
      <FlexWidget style={{ height: 'match_parent', width: 'match_parent', padding: 12, backgroundColor: '#FFFFFF', borderRadius: 16 }}>
        <TextWidget text="Nada para revisar agora" style={{ fontSize: 14, color: '#1F2937' }} />
      </FlexWidget>
    );
  }
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'studify://practice/review' }}
      style={{ height: 'match_parent', width: 'match_parent', padding: 12, backgroundColor: '#FFFFFF', borderRadius: 16, flexDirection: 'column' }}
    >
      <TextWidget text="Revisão rápida" style={{ fontSize: 12, color: '#6B7280' }} />
      <TextWidget text={revealed ? card.back : card.front} maxLines={4} style={{ fontSize: 15, color: '#111827' }} />
      {revealed ? (
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', justifyContent: 'space-between' }}>
          <FlexWidget
            clickAction="RATE"
            clickActionData={{ cardId: card.cardId, rating: 'again' }}
            accessibilityLabel="Errei"
            style={{ padding: 8, backgroundColor: '#FEE2E2', borderRadius: 8 }}
          >
            <TextWidget text="Errei" style={{ fontSize: 14, color: '#991B1B' }} />
          </FlexWidget>
          <FlexWidget
            clickAction="RATE"
            clickActionData={{ cardId: card.cardId, rating: 'good' }}
            accessibilityLabel="Acertei"
            style={{ padding: 8, backgroundColor: '#DCFCE7', borderRadius: 8 }}
          >
            <TextWidget text="Acertei" style={{ fontSize: 14, color: '#166534' }} />
          </FlexWidget>
        </FlexWidget>
      ) : (
        <FlexWidget
          clickAction="REVEAL"
          clickActionData={{ cardId: card.cardId }}
          accessibilityLabel="Mostrar resposta"
          style={{ padding: 8, backgroundColor: '#E0E7FF', borderRadius: 8 }}
        >
          <TextWidget text="Mostrar" style={{ fontSize: 14, color: '#3730A3' }} />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}

type Render = WidgetTaskHandlerProps['renderWidget'];

function renderFromDatabase(db: AppDb, renderWidget: Render): void {
  const card = nextCard(db);
  const revealed = card !== null && revealedCardId() === card.cardId;
  renderWidget(<ReviewWidgetView card={card} revealed={revealed} />);
}

/** Task handler: every widget action re-renders from the current queue. */
export async function reviewWidgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetAction, clickAction, clickActionData, renderWidget } = props;
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

  renderFromDatabase(db, renderWidget);
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
    const card = nextCard(db);
    const revealed = card !== null && revealedCardId() === card.cardId;
    await requestWidgetUpdate({
      widgetName: REVIEW_WIDGET_NAME,
      renderWidget: () => <ReviewWidgetView card={card} revealed={revealed} />,
      widgetNotFound: () => undefined,
    });
  },
};
