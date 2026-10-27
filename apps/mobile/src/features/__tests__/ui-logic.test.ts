/// <reference types="jest" />
import { formatInviteCode, isValidInviteCode, normalizeInviteCode } from '../auth/onboarding';
import { ageFrom } from '../auth/session';
import { countdown, formatClock, formatGrade, formatMinutes, longInterval, pageLabel, shortInterval, toLocalDate, weekdayDate } from '../common/format';
import { buildOutline, type KnowledgeNode } from '../subjects/outline';
import { matchSpans } from '../subjects/highlight';
import { renderCloze } from '../../components/Flashcard';

jest.mock('../../api/supabase', () => ({ supabase: {} }));
jest.mock('react-native-webview', () => ({ WebView: () => null }));

describe('pt-BR formatting (copy-pt-br §2)', () => {
  it('formats grades with a decimal comma and integers on 0–100', () => {
    expect(formatGrade(7.5)).toBe('7,5');
    expect(formatGrade(75, 100)).toBe('75');
    expect(formatGrade(null)).toBe('—');
  });
  it('formats durations and clocks', () => {
    expect(formatMinutes(25)).toBe('25 min');
    expect(formatMinutes(90)).toBe('1h30');
    expect(formatClock(750)).toBe('12:30');
  });
  it('formats rating intervals short and spoken', () => {
    expect(shortInterval(10 * 60_000)).toBe('10 min');
    expect(shortInterval(3 * 86_400_000)).toBe('3 d');
    expect(longInterval(86_400_000)).toBe('1 dia');
    expect(longInterval(3 * 86_400_000)).toBe('3 dias');
  });
  it('formats page chips as 📄 p. N / p. N–M', () => {
    expect(pageLabel(12)).toBe('📄 p. 12');
    expect(pageLabel(12, 14)).toBe('📄 p. 12–14');
    expect(pageLabel(12, 12)).toBe('📄 p. 12');
  });
  it('formats weekday dates as "qua, 14/11"', () => {
    expect(weekdayDate('2026-11-11')).toBe('qua, 11/11');
    expect(toLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  it('builds countdown copy', () => {
    const now = new Date(2026, 10, 10, 9);
    expect(countdown('2026-11-13', false, now)).toBe('Faltam 3 dias');
    expect(countdown('2026-11-11', false, now)).toBe('É amanhã!');
    expect(countdown(new Date(2026, 10, 10, 14).toISOString(), true, now)).toBe('Hoje às 14:00');
  });
});

describe('invite codes (security §9 alphabet)', () => {
  it('normalizes and validates', () => {
    expect(normalizeInviteCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(isValidInviteCode('ABCDEFGH')).toBe(true);
    expect(isValidInviteCode('ABCDEFGL')).toBe(false); // L excluded
    expect(isValidInviteCode('ABCD0FGH')).toBe(false); // 0 excluded
    expect(formatInviteCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('age gate (SP-01)', () => {
  it('computes age from month + year only', () => {
    const now = new Date(2026, 9, 27);
    expect(ageFrom(2014, 10, now)).toBe(12);
    expect(ageFrom(2014, 11, now)).toBe(11);
  });
});

describe('citation highlight matching (ING-08)', () => {
  const spans = [
    { text: 'A mitose forma duas', x: 0.1, y: 0.1, w: 0.5, h: 0.02 },
    { text: 'células iguais à mãe.', x: 0.1, y: 0.13, w: 0.5, h: 0.02 },
    { text: 'A meiose forma quatro células.', x: 0.1, y: 0.2, w: 0.5, h: 0.02 },
  ];
  it('finds the spans covering the cited text, accent-insensitive', () => {
    const hit = matchSpans(spans, 'a mitose forma duas celulas iguais a mae');
    expect(hit).toHaveLength(2);
    expect(hit[0]!.y).toBe(0.1);
  });
  it('returns nothing (never an error) when the text is not on the page', () => {
    expect(matchSpans(spans, 'fotossíntese ocorre nos cloroplastos')).toEqual([]);
    expect(matchSpans(spans, null)).toEqual([]);
  });
});

describe('outline tree (ING-03, ING-04.6)', () => {
  const base = { subject_id: 's', summary: null, learning_objectives: [], key_terms: [], formulas: [], is_placeholder: false, est_learn_minutes: null, content_status: 'ready' as const, hidden_reason: null };
  const nodes: KnowledgeNode[] = [
    { ...base, id: 'u1', parent_id: null, kind: 'unit', title: 'Unidade 1', position: 0 },
    { ...base, id: 't2', parent_id: 'u1', kind: 'topic', title: 'Meiose', position: 1 },
    { ...base, id: 't1', parent_id: 'u1', kind: 'topic', title: 'Mitose', position: 0 },
    { ...base, id: 'c1', parent_id: 't1', kind: 'concept', title: 'Prófase', position: 0 },
  ];
  it('nests, orders by position and lists topics', () => {
    const o = buildOutline(nodes, [{ node_id: 't1', document_id: 'd', page_start: 3, page_end: 4 }], new Set());
    expect(o.roots).toHaveLength(1);
    expect(o.roots[0]!.children.map((c) => c.title)).toEqual(['Mitose', 'Meiose']);
    expect(o.topics).toHaveLength(2);
    expect(o.byId.get('t1')!.sources[0]!.page_start).toBe(3);
  });
  it('propagates "não cai na prova" from a topic to its concepts', () => {
    const o = buildOutline(nodes, [], new Set(['t1']));
    expect(o.byId.get('c1')!.excluded).toBe(true);
    expect(o.byId.get('t2')!.excluded).toBe(false);
  });
});

describe('cloze cards (MEM-01)', () => {
  it('blanks the active cloze on the front and bolds it on the back', () => {
    const text = 'A {{c1::mitocôndria}} produz {{c2::ATP::energia}}.';
    expect(renderCloze(text, 'front', 1)).toBe('A […] produz ATP.');
    expect(renderCloze(text, 'front', 2)).toBe('A mitocôndria produz [… energia].');
    expect(renderCloze(text, 'back', 1)).toBe('A **mitocôndria** produz ATP.');
  });
});
