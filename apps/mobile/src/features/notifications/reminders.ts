// Local reminders with rich layouts (mobile-app.md §5, api.md §9 "local" types): reviews due (with the next
// card to answer right from the notification), the day's plan, the exam-eve countdown, the streak ring and
// the grade prompt. Pure: the snapshot comes from SQLite and the motivation summary (reminder-sync.ts), and
// the existing policy decides quiet hours and the 3-per-day cap.
import { parseRichNotification, type RichNotification, type RichNotificationInput } from '@studify/shared';
import { renderCloze } from '../../components/cloze';
import { planReminders, type DroppedReminder, type QuietHours, type ReminderChannel } from '../../platform/notification-policy';

export interface ReminderSnapshot {
  now: Date;
  enabled: boolean;
  /** Channel toggles of Perfil → Notificações. */
  channels: { reviews: boolean; plan: boolean };
  quiet: QuietHours;
  /** "HH:mm" study window start and Modo Véspera time (study_preferences). */
  windowStart: string;
  vesperaTime: string;
  /** Review reminder times: the best energy windows first (GOL-10), else the window start. */
  reviewTimes: string[];
  /** Cards waiting at the reminder time of today, tomorrow and the day after. */
  dueByDay: number[];
  nextCard: { id: string; front: string; back: string; type: string; clozeIndex: number | null; subject: string | null; color: string | null } | null;
  /** Planned items of today (index 0) and tomorrow (index 1). */
  plans: { title: string; minutes: number }[][];
  exams: { id: string; goalId: string; title: string; subject: string | null; color: string | null; localDate: string; startsAt: Date | null; topics: number }[];
  ungraded: { id: string; goalId: string; title: string }[];
  streak: { current: number; shields: number; todayMinutes: number; goalMinutes: number } | null;
}

export interface PlannedReminder {
  id: string;
  at: Date;
  rich: RichNotification;
}

/** Study reminders never fire after 20:00 (spec 13 §5.2). */
const LATEST = '20:00';
const DAY = 86_400_000;

function at(now: Date, dayOffset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h ?? 0, m ?? 0, 0, 0);
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Card text for a notification: cloze blanks, no markdown or LaTeX delimiters, one paragraph. */
export function cardText(text: string, side: 'front' | 'back', type: string, clozeIndex: number | null, max: number): string {
  const raw = type === 'cloze' ? renderCloze(text, side, clozeIndex) : text;
  const plain = raw
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function build(input: RichNotificationInput): RichNotification | null {
  return parseRichNotification(input);
}

export function planRichReminders(s: ReminderSnapshot): { scheduled: PlannedReminder[]; dropped: DroppedReminder[] } {
  if (!s.enabled) return { scheduled: [], dropped: [] };
  const out: { channel: ReminderChannel; requested: boolean; at: Date; rich: RichNotification }[] = [];
  const add = (channel: ReminderChannel, requested: boolean, when: Date, rich: RichNotification | null) => {
    if (rich) out.push({ channel, requested, at: when, rich });
  };
  const latestToday = (d: number) => at(s.now, d, LATEST);

  // Reviews due (MEM-02): today with the next card itself (Ver resposta → Errei / Acertei), then two days.
  if (s.channels.reviews) {
    for (let d = 0; d < 3; d++) {
      const n = s.dueByDay[d] ?? 0;
      if (n < 1) continue;
      const time = s.reviewTimes.map((t) => at(s.now, d, t)).find((x) => x > s.now && x <= latestToday(d));
      if (!time) continue;
      const card = d === 0 ? s.nextCard : null;
      const common = {
        v: 1 as const,
        key: `reviews:${dateKey(time)}`,
        channel: 'reviews' as const,
        title: 'Revisões do dia',
        body: n === 1 ? 'Tem 1 cartão te esperando — rapidinho!' : `Tem ${n} cartões te esperando — rapidinho!`,
        glyph: 'cards' as const,
        accent: card?.color ?? '#15803D',
        deep_link: 'studify://practice/review',
        group: 'lembretes',
      };
      add(
        'reviews',
        false,
        time,
        card
          ? build({
              ...common,
              template: 'card',
              ...(card.subject ? { sub: card.subject.slice(0, 60) } : {}),
              card: {
                card_id: card.id,
                front: cardText(card.front, 'front', card.type, card.clozeIndex, 200) || 'Cartão',
                back: cardText(card.back || card.front, 'back', card.type, card.clozeIndex, 300),
                due: n,
              },
              actions: [
                { id: 'reveal', label: 'Ver resposta', kind: 'reveal' },
                { id: 'open', label: `Revisar ${n}`, kind: 'open', deep_link: 'studify://practice/review' },
                { id: 'later', label: 'Mais tarde', kind: 'snooze', snooze_min: 60 },
              ],
            })
          : build({ ...common, template: 'basic', actions: [{ id: 'open', label: `Revisar ${n}`, kind: 'open', deep_link: 'studify://practice/review' }] }),
      );
    }
  }

  if (s.channels.plan) {
    // The day's plan at the start of the study window (GOL-05): a digest of what is planned.
    for (let d = 0; d < 2; d++) {
      const items = s.plans[d] ?? [];
      if (!items.length) continue;
      const time = at(s.now, d, s.windowStart);
      if (time <= s.now) continue;
      const minutes = items.reduce((sum, i) => sum + i.minutes, 0);
      add(
        'plan',
        true,
        time,
        build({
          v: 1,
          key: `plan:${dateKey(time)}`,
          template: 'digest',
          channel: 'plan',
          title: 'Seu plano de hoje',
          body: `${minutes} min · ${items.length} ${items.length === 1 ? 'atividade' : 'atividades'}`,
          glyph: 'calendar',
          deep_link: 'studify://today',
          digest: { lines: items.slice(0, 6).map((i) => `• ${i.title} · ${i.minutes} min`.slice(0, 80)) },
          actions: [{ id: 'open', label: 'Começar sessão', kind: 'open', deep_link: 'studify://today' }],
        }),
      );
    }

    // Exam eve (GOL-07): a countdown to the test, at the Modo Véspera time of the day before.
    for (const e of s.exams) {
      for (let d = 0; d < 3; d++) {
        if (dateKey(new Date(at(s.now, d, '12:00').getTime() + DAY)) !== e.localDate) continue;
        const time = at(s.now, d, s.vesperaTime);
        if (time <= s.now) continue;
        const target = e.startsAt ?? at(s.now, d + 1, '07:30');
        add(
          'plan',
          true,
          time,
          build({
            v: 1,
            key: `eve:${e.id}`,
            template: 'countdown',
            channel: 'plan',
            title: `Amanhã: ${e.title}`.slice(0, 80),
            body: `Amanhã tem prova${e.subject ? ` de ${e.subject}` : ''}. Bora revisar o essencial com o Modo Véspera?`.slice(0, 240),
            glyph: 'calendar',
            ...(e.color ? { accent: e.color } : {}),
            ...(e.subject ? { sub: e.subject.slice(0, 60) } : {}),
            deep_link: `studify://goal/${e.goalId}/eve/${e.id}`,
            countdown: { target_at: target.toISOString(), label: e.title.slice(0, 40), chips: e.topics > 0 ? [`${e.topics} ${e.topics === 1 ? 'tópico' : 'tópicos'}`] : [] },
            actions: [{ id: 'open', label: 'Modo Véspera', kind: 'open', deep_link: `studify://goal/${e.goalId}/eve/${e.id}` }],
          }),
        );
      }
    }

    // Streak at risk (MOT-01): the goal ring, at 19:00, only when today's goal is not met yet.
    const st = s.streak;
    if (st && st.current > 0 && st.todayMinutes < st.goalMinutes) {
      const time = at(s.now, 0, '19:00');
      if (time > s.now) {
        const left = st.goalMinutes - st.todayMinutes;
        add(
          'plan',
          false,
          time,
          build({
            v: 1,
            key: `streak:${dateKey(time)}`,
            template: 'goal',
            channel: 'plan',
            title: `Sua sequência de ${st.current} ${st.current === 1 ? 'dia' : 'dias'} 🔥`,
            body: `Faltam ${left} min para a meta de hoje. Bora manter?`,
            glyph: 'flame',
            accent: '#EA580C',
            deep_link: 'studify://today',
            goal: { done_min: Math.min(1440, st.todayMinutes), goal_min: Math.max(1, st.goalMinutes), streak: st.current, shields: Math.min(2, st.shields) },
            actions: [
              { id: 'open', label: 'Estudar agora', kind: 'open', deep_link: 'studify://today' },
              { id: 'later', label: 'Daqui a pouco', kind: 'snooze', snooze_min: 30 },
            ],
          }),
        );
      }
    }

    // Grade prompt (GOL-06.4): one test at a time, at 18:00.
    const g = s.ungraded[0];
    if (g) {
      const today = at(s.now, 0, '18:00');
      const time = today > s.now ? today : at(s.now, 1, '18:00');
      const link = `studify://goal/${g.goalId}/exam/${g.id}?log=1`;
      add(
        'plan',
        false,
        time,
        build({
          v: 1,
          key: `grade:${g.id}`,
          template: 'basic',
          channel: 'plan',
          title: 'Como foi a prova?',
          body: `Registre a nota de ${g.title} para eu recalcular o que falta.`.slice(0, 240),
          glyph: 'pen',
          deep_link: link,
          actions: [{ id: 'open', label: 'Registrar nota', kind: 'open', deep_link: link }],
        }),
      );
    }
  }

  const policy = planReminders(
    out.map((r) => ({ id: r.rich.key, channel: r.channel, title: r.rich.title, body: r.rich.body, at: r.at, requested: r.requested })),
    { now: s.now, quiet: s.quiet },
  );
  const byKey = new Map(out.map((r) => [r.rich.key, r]));
  return {
    scheduled: policy.scheduled.map((c) => ({ id: c.id, at: c.at, rich: byKey.get(c.id)!.rich })),
    dropped: policy.dropped,
  };
}
