/// <reference types="jest" />
import { RICH_TEMPLATES, parseRichNotification } from '@studify/shared';
import { parseNotificationTap } from '../../../platform/notification-links';
import { countdownLabel, groupInbox, relativeTime, sectionOf, toInboxItem, type InboxRow } from '../inbox';
import { cardText, planRichReminders, type ReminderSnapshot } from '../reminders';
import { previewSamples } from '../samples';

jest.mock('../../../api/supabase', () => ({ supabase: {} }));
jest.mock('../../auth/session', () => ({ useSession: () => ({ userId: null }) }));
jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../../lib/kv', () => ({ getKv: () => ({ getString: () => undefined, set: () => undefined }) }));

// Tuesday 27 Oct 2026, local time.
const at = (h: number, m = 0, day = 27) => new Date(2026, 9, day, h, m, 0);

const snapshot = (over: Partial<ReminderSnapshot> = {}): ReminderSnapshot => ({
  now: at(9),
  enabled: true,
  channels: { reviews: true, plan: true },
  quiet: { start: '22:00', end: '07:00' },
  windowStart: '14:00',
  vesperaTime: '19:00',
  reviewTimes: ['15:00'],
  dueByDay: [14, 5, 0],
  nextCard: { id: 'card-1', front: 'O {{c1::carbono}} tem número atômico 6', back: '', type: 'cloze', clozeIndex: 1, subject: 'Química', color: '#7C3AED' },
  plans: [[{ title: 'Revisar cartões', minutes: 15 }, { title: 'Mapa de Genética', minutes: 20 }], [{ title: 'Quiz de Física', minutes: 10 }]],
  exams: [{ id: 'exam-1', goalId: 'goal-1', title: 'Prova de Biologia', subject: 'Biologia', color: '#15803D', localDate: '2026-10-28', startsAt: null, topics: 6 }],
  ungraded: [{ id: 'exam-0', goalId: 'goal-1', title: 'Prova de Física' }],
  streak: { current: 12, shields: 1, todayMinutes: 5, goalMinutes: 20 },
  ...over,
});

describe('planRichReminders', () => {
  it('plans every kind with its rich layout, all valid for the native renderer', () => {
    const plan = planRichReminders(snapshot());
    const byKey = new Map(plan.scheduled.map((r) => [r.rich.key, r]));
    expect([...byKey.keys()].sort()).toEqual(['eve:exam-1', 'grade:exam-0', 'plan:2026-10-27', 'plan:2026-10-28', 'reviews:2026-10-27', 'reviews:2026-10-28', 'streak:2026-10-27']);
    for (const r of plan.scheduled) expect(parseRichNotification(r.rich)).not.toBeNull();

    const today = byKey.get('reviews:2026-10-27')!;
    expect(today.at).toEqual(at(15));
    expect(today.rich.template).toBe('card');
    expect(today.rich.card).toMatchObject({ card_id: 'card-1', front: 'O […] tem número atômico 6', back: 'O carbono tem número atômico 6', due: 14 });
    expect(today.rich.actions.map((a) => a.kind)).toEqual(['reveal', 'open', 'snooze']);
    expect(byKey.get('reviews:2026-10-28')!.rich.template).toBe('basic');

    const eve = byKey.get('eve:exam-1')!;
    expect(eve.at).toEqual(at(19));
    expect(eve.rich.template).toBe('countdown');
    expect(eve.rich.countdown?.chips).toEqual(['6 tópicos']);
    expect(eve.rich.deep_link).toBe('studify://goal/goal-1/eve/exam-1');

    expect(byKey.get('streak:2026-10-27')!.rich.goal).toEqual({ done_min: 5, goal_min: 20, streak: 12, shields: 1 });
    expect(byKey.get('plan:2026-10-27')!.rich.digest?.lines).toEqual(['• Revisar cartões · 15 min', '• Mapa de Genética · 20 min']);
  });

  it('respects the switch, the channels, 20:00 and quiet hours', () => {
    expect(planRichReminders(snapshot({ enabled: false })).scheduled).toEqual([]);

    const reviewsOff = planRichReminders(snapshot({ channels: { reviews: false, plan: true } }));
    expect(reviewsOff.scheduled.some((r) => r.rich.channel === 'reviews')).toBe(false);

    const late = planRichReminders(snapshot({ reviewTimes: ['21:00'] }));
    expect(late.scheduled.some((r) => r.rich.key.startsWith('reviews:'))).toBe(false);

    const quiet = planRichReminders(snapshot({ windowStart: '23:00' }));
    expect(quiet.scheduled.some((r) => r.rich.key.startsWith('plan:'))).toBe(false);
    expect(quiet.dropped.filter((d) => d.reason === 'quiet_hours').map((d) => d.id)).toEqual(['plan:2026-10-27', 'plan:2026-10-28']);
  });

  it('keeps unrequested reminders within 3 per day and skips a met goal', () => {
    const plan = planRichReminders(snapshot({ reviewTimes: ['10:00'], streak: { current: 3, shields: 0, todayMinutes: 25, goalMinutes: 20 } }));
    expect(plan.scheduled.some((r) => r.rich.key.startsWith('streak:'))).toBe(false);
    const unrequestedToday = plan.scheduled.filter((r) => r.at.getDate() === 27 && (r.rich.key.startsWith('reviews:') || r.rich.key.startsWith('grade:')));
    expect(unrequestedToday.length).toBeLessThanOrEqual(3);
  });
});

describe('cardText', () => {
  it('blanks cloze, strips markdown and LaTeX delimiters, and truncates', () => {
    expect(cardText('**Mitocôndria** é a $usina$ da célula', 'front', 'basic', null, 200)).toBe('Mitocôndria é a usina da célula');
    expect(cardText('{{c1::Brasília::capital}} é a capital', 'front', 'cloze', 1, 200)).toBe('[… capital] é a capital');
    expect(cardText('a'.repeat(50), 'front', 'basic', null, 10)).toBe(`${'a'.repeat(9)}…`);
  });
});

describe('inbox helpers', () => {
  const now = at(15);
  it('formats relative times and sections in PT-BR', () => {
    expect(relativeTime(at(14, 59, 27).toISOString(), now)).toBe('há 1 min');
    expect(relativeTime(new Date(now.getTime() - 20_000).toISOString(), now)).toBe('agora');
    expect(relativeTime(at(10).toISOString(), now)).toBe('há 5 h');
    expect(relativeTime(at(22, 0, 26).toISOString(), now)).toBe('ontem');
    expect(relativeTime(at(12, 0, 23).toISOString(), now)).toBe('sex');
    expect(relativeTime(at(12, 0, 2).toISOString(), now)).toBe('02/10');
    expect(sectionOf(at(1).toISOString(), now)).toBe('today');
    expect(sectionOf(at(12, 0, 22).toISOString(), now)).toBe('week');
  });

  it('groups newest first into non-empty sections', () => {
    const items = [at(14), at(8, 0, 26), at(9, 0, 1)].map((d, i) => ({ id: String(i), created_at: d.toISOString() }));
    expect(groupInbox(items, now).map((g) => [g.section, g.items.map((i) => i.id)])).toEqual([
      ['today', ['0']],
      ['yesterday', ['1']],
      ['older', ['2']],
    ]);
  });

  it('counts down to an event', () => {
    expect(countdownLabel(at(15, 30).toISOString(), now)).toBe('em 30 min');
    expect(countdownLabel(at(18, 10).toISOString(), now)).toBe('em 3 h 10 min');
    expect(countdownLabel(at(19, 0, 29).toISOString(), now)).toBe('em 2 d 4 h');
    expect(countdownLabel(at(14).toISOString(), now)).toBe('agora');
  });

  it('turns rows without a usable rich payload into basic cards', () => {
    const row: InboxRow = {
      id: 'r1',
      key: 'material:doc-1',
      type: 'material_ready',
      channel: 'processing',
      title: 'Material pronto',
      body: 'Seus cartões estão prontos.',
      deep_link: 'studify://subject/s1',
      rich: { v: 2, nonsense: true },
      read_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const item = toInboxItem(row);
    expect(item.rich).toMatchObject({ template: 'basic', title: 'Material pronto', glyph: 'sparkles', deep_link: 'studify://subject/s1' });
    const rich = previewSamples(now)[0]!;
    expect(toInboxItem({ ...row, rich }).rich).toEqual(rich);
  });
});

describe('notification taps', () => {
  it('strips the notification key and keeps the route and its other params', () => {
    expect(parseNotificationTap('studify://practice/review?notif=reviews%3A2026-10-27')).toEqual({ path: '/practice/review', key: 'reviews:2026-10-27' });
    expect(parseNotificationTap('studify://goal/g1/exam/e1?log=1&notif=grade%3Ae1')).toEqual({ path: '/goal/g1/exam/e1?log=1', key: 'grade:e1' });
    expect(parseNotificationTap('/today?notif=plan%3A2026-10-27')).toEqual({ path: '/today', key: 'plan:2026-10-27' });
    expect(parseNotificationTap('studify://class/c1/battle/b1?notif=battle%3Ab1')).toEqual({ path: '/battle/b1', key: 'battle:b1' });
  });

  it('leaves other links alone', () => {
    expect(parseNotificationTap('studify://q/abc')).toBeNull();
    expect(parseNotificationTap('studify://today?tab=plan')).toBeNull();
    expect(parseNotificationTap('studify://today?notif=%E0%A4%A')).toBeNull();
  });
});

describe('preview samples', () => {
  it('cover every template and all parse', () => {
    const samples = previewSamples(at(9));
    expect(new Set(samples.map((s) => s.template))).toEqual(new Set(RICH_TEMPLATES));
    expect(samples).toHaveLength(RICH_TEMPLATES.length);
  });
});
