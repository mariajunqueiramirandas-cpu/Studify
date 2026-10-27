/// <reference types="jest" />
import { formatDueIn, formatGrade, formatInterval, formatRelativeDays, formatAgo, calendarDaysBetween } from '../format';
import { studyDateOf, localDateOf } from '../dates';

const noon = new Date(2026, 9, 27, 12, 0, 0); // local time

describe('pt-BR formatting', () => {
  it('formats relative days', () => {
    expect(formatRelativeDays(noon, noon)).toBe('hoje');
    expect(formatRelativeDays(new Date(2026, 9, 28, 9), noon)).toBe('amanhã');
    expect(formatRelativeDays(new Date(2026, 9, 26, 9), noon)).toBe('ontem');
    expect(formatRelativeDays(new Date(2026, 9, 30, 9), noon)).toBe('em 3 dias');
    expect(formatRelativeDays(new Date(2026, 9, 24, 9), noon)).toBe('há 3 dias');
  });

  it('formats review intervals', () => {
    expect(formatInterval(0)).toBe('menos de 1 dia');
    expect(formatInterval(1)).toBe('1 dia');
    expect(formatInterval(3)).toBe('3 dias');
    expect(formatInterval(60)).toBe('2 meses');
    expect(formatInterval(400)).toBe('1 ano');
  });

  it('formats short due horizons', () => {
    expect(formatDueIn(noon.getTime(), noon)).toBe('agora');
    expect(formatDueIn(noon.getTime() + 10 * 60_000, noon)).toBe('em 10 min');
    expect(formatDueIn(noon.getTime() + 3 * 3_600_000, noon)).toBe('em 3 h');
  });

  it('formats grades with a decimal comma', () => {
    expect(formatGrade(7.5)).toBe('7,5');
    expect(formatGrade(10)).toBe('10');
    expect(formatGrade(7.456, 10)).toBe('7,46 / 10');
    expect(formatGrade(6, 10, 1)).toBe('6 / 10');
  });

  it('formats time since a sync', () => {
    expect(formatAgo(noon.getTime() - 30_000, noon)).toBe('agora há pouco');
    expect(formatAgo(noon.getTime() - 5 * 60_000, noon)).toBe('há 5 min');
    expect(formatAgo(noon.getTime() - 3 * 3_600_000, noon)).toBe('há 3 horas');
  });

  it('counts calendar days and study days with the rollover hour', () => {
    expect(calendarDaysBetween(noon, new Date(2026, 9, 30, 0))).toBe(3);
    expect(localDateOf(noon)).toBe('2026-10-27');
    // 02:00 belongs to the previous study day (rollover at 04:00).
    expect(studyDateOf(new Date(2026, 9, 27, 2, 0), 4)).toBe('2026-10-26');
    expect(studyDateOf(new Date(2026, 9, 27, 5, 0), 4)).toBe('2026-10-27');
  });
});
