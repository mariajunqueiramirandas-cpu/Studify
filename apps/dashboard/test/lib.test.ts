// Pure modules of the dashboard: formatting, routing, ids, chart geometry and the overview's alerts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdminOverview } from '@studify/shared';
import { uuidv7 } from '../src/lib/api.ts';
import { readConfig } from '../src/lib/config.ts';
import { featureName, formatUsdTick, formatDay, formatDuration, formatPct, formatRelative, formatUsd, groupCode, initials, parseUsd, quietMinutes, usdInput } from '../src/lib/format.ts';
import { href, innerPath, match } from '../src/lib/router.tsx';
import { columnPath, meterLevel, niceStep, ticksFor } from '../src/ui/charts.tsx';
import { attentionItems, projectMonth } from '../src/pages/admin/Overview.tsx';
import { describeDetails } from '../src/pages/admin/Audit.tsx';

/** Intl separates "US$" from the amount with a no-break space. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

describe('money', () => {
  it('shows micro-USD as dollars in pt-BR', () => {
    expect(plain(formatUsd(1_234_560))).toBe('US$ 1,23');
    expect(plain(formatUsd(0))).toBe('US$ 0,00');
    expect(plain(formatUsd(4_200))).toBe('US$ 0,0042');
  });

  it('reads what the owner types, with comma or dot', () => {
    expect(parseUsd('1,50')).toBe(1_500_000);
    expect(parseUsd('US$ 2.25')).toBe(2_250_000);
    expect(parseUsd('100')).toBe(100_000_000);
    expect(parseUsd('abc')).toBeNull();
    expect(parseUsd('1,2,3')).toBeNull();
    expect(parseUsd('-1')).toBeNull();
    expect(usdInput(1_500_000)).toBe('1,50');
    expect(usdInput(null)).toBe('');
    // Ticks show as many decimals as their step needs, so 0,015 and 0,02 never collapse into the same label.
    expect([0, 5_000, 10_000, 15_000].map((v) => plain(formatUsdTick(v, 5_000)))).toEqual(['US$ 0,000', 'US$ 0,005', 'US$ 0,010', 'US$ 0,015']);
    expect(plain(formatUsdTick(2_500, 2_500))).toBe('US$ 0,0025');
    expect(plain(formatUsdTick(500_000, 500_000))).toBe('US$ 0,50');
  });
});

describe('words and numbers', () => {
  it('formats percentages, days, durations and codes', () => {
    expect(formatPct(42)).toBe('42%');
    expect(formatPct(0.125, { ratio: true, digits: 1 })).toBe('12,5%');
    expect(formatPct(null)).toBe('—');
    expect(formatDay('2026-10-27')).toMatch(/27/);
    expect(formatDuration(540)).toBe('9 h');
    expect(formatDuration(390)).toBe('6 h 30 min');
    expect(groupCode('K7QX9HMR')).toBe('K7QX-9HMR');
    expect(initials('Ana Beatriz Souza')).toBe('AS');
    expect(featureName('TUT-01')).toBe('Tutor');
    expect(featureName('XYZ-99')).toBe('XYZ-99');
  });

  it('says relative times in Portuguese', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(formatRelative('2026-10-29T11:59:50Z', now)).toBe('agora');
    expect(formatRelative('2026-10-26T12:00:00Z', now)).toBe('há 3 dias');
    expect(formatRelative('2026-10-29T10:00:00Z', now)).toBe('há 2 horas');
  });

  it('measures quiet hours across midnight', () => {
    expect(quietMinutes('22:00', '07:00')).toBe(540);
    expect(quietMinutes('23:30', '06:00')).toBe(390);
  });
});

describe('router', () => {
  it('maps /painel paths in and out', () => {
    expect(innerPath('/painel')).toBe('/');
    expect(innerPath('/painel/')).toBe('/');
    expect(innerPath('/painel/admin/usuarios/')).toBe('/admin/usuarios');
    expect(innerPath('/outra')).toBe('/');
    expect(innerPath('/painelzinho')).toBe('/');
    expect(href('/')).toBe('/painel/');
    expect(href('/perfil')).toBe('/painel/perfil');
  });

  it('matches routes with params', () => {
    expect(match('/admin/usuarios/:id', '/admin/usuarios/abc')).toEqual({ id: 'abc' });
    expect(match('/admin/usuarios/:id', '/admin/usuarios')).toBeNull();
    expect(match('/', '/')).toEqual({});
    expect(match('/perfil', '/turmas')).toBeNull();
  });
});

describe('ids and config', () => {
  it('makes UUID v7 idempotency keys the API accepts', () => {
    const id = uuidv7(Date.parse('2026-10-29T12:00:00Z'), new Uint8Array(16).fill(255));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.slice(0, 13).replace('-', '')).toBe('01a187880200');
    expect(uuidv7()).not.toBe(uuidv7());
  });

  it('reads the settings the API puts in the page, and nothing when the placeholder is left', () => {
    const doc = (content: string) => ({ querySelector: () => ({ getAttribute: () => content }) }) as unknown as Document;
    expect(readConfig(doc('{"supabaseUrl":"https://x.supabase.co","supabaseAnonKey":"pk"}'))).toEqual({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'pk' });
    expect(readConfig(doc('%STUDIFY_CONFIG%'))).toBeNull();
    expect(readConfig(doc('{"supabaseUrl":"","supabaseAnonKey":"pk"}'))).toBeNull();
  });
});

describe('charts', () => {
  it('picks clean ticks', () => {
    expect(niceStep(100)).toBe(25);
    expect(niceStep(7)).toBe(2);
    expect(ticksFor(90)).toEqual([0, 25, 50, 75, 100]);
    expect(ticksFor(0)).toEqual([0, 1]);
    expect(ticksFor(1, 4, true)).toEqual([0, 1]);
    expect(ticksFor(3, 4, true)).toEqual([0, 1, 2, 3]);
  });

  it('rounds the data end and keeps the baseline square', () => {
    expect(columnPath(0, 10, 20, 50)).toBe('M0,60V14Q0,10 4,10H16Q20,10 20,14V60Z');
    expect(columnPath(0, 58, 20, 2)).toBe('M0,60V60Q0,58 2,58H18Q20,58 20,60V60Z');
  });

  it('turns the meter to warning at 80% and critical at 100%', () => {
    expect(meterLevel(0.5)).toBe('normal');
    expect(meterLevel(0.8)).toBe('warning');
    expect(meterLevel(1.2)).toBe('critical');
  });
});

describe('overview alerts', () => {
  const base: AdminOverview = {
    users: { total: 10, new_7d: 1, active_7d: 5, admins: 1, pending_names: 0, suspended: 0 },
    series: [],
    spend: { today: 0, month: 0, cap_used: 0, cap: 100_000_000, month_start: '2026-10-01', today_date: '2026-10-10', top_features: [], top_class_groups: [], outliers_today: [] },
    moderation: { open_reports: 0, escalated_reports: 0, open_flags: 0, pending_names: 0, feedback_7d: 0 },
    ops: { failed_jobs_24h: 0, running_jobs: 0, waiting_budget_jobs: 0, pending_deletions: 0, failed_deletions: 0, open_exports: 0, recent_failures: [] },
    generated_at: '2026-10-10T12:00:00Z',
    server: { version: '0.1.0', started_at: '2026-10-10T00:00:00Z' },
  };

  it('projects the month at the current pace', () => {
    expect(projectMonth(10_000_000, '2026-10-10')).toEqual({ projected: 31_000_000, daysInMonth: 31, day: 10 });
  });

  it('is empty when nothing needs the owner', () => {
    expect(attentionItems(base)).toEqual([]);
  });

  it('warns before the cap runs out and says when it has', () => {
    expect(attentionItems({ ...base, spend: { ...base.spend, cap_used: 40_000_000 } })[0]?.text).toMatch(/antes do fim do mês/);
    expect(attentionItems({ ...base, spend: { ...base.spend, cap_used: 85_000_000 } })[0]?.level).toBe('warning');
    expect(attentionItems({ ...base, spend: { ...base.spend, cap_used: 100_000_000 } })[0]?.level).toBe('critical');
  });

  it('lists outliers, the moderation queue and failed deletions', () => {
    const items = attentionItems({
      ...base,
      spend: { ...base.spend, outliers_today: [{ id: 'u1', display_name: 'Ana', cost: 900_000, median: 100_000 }] },
      moderation: { ...base.moderation, open_reports: 2, pending_names: 1 },
      ops: { ...base.ops, failed_deletions: 1 },
    });
    expect(items.map((i) => i.to)).toEqual(['/admin/usuarios', '/admin/usuarios/u1', '/admin/moderacao', '/admin/moderacao']);
    expect(items[0]?.level).toBe('critical');
  });
});

describe('audit details', () => {
  it('reads like a sentence', () => {
    expect(plain(describeDetails({ global_month_micro_usd: 200_000_000, user_day_micro_usd: null }))).toBe('teto global: US$ 200,00; por pessoa por dia: padrão');
    expect(describeDetails({ enabled_all: true, percentage: 20 })).toBe('para todos: sim; porcentagem: 20');
  });
});

describe('bundle boundary', () => {
  // The image builds the dashboard without the shared package's source (apps/api/Dockerfile, stage dashboard):
  // only its types may be imported.
  it('imports @studify/shared for types only', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(path.resolve(__dirname, '../src'));
    const offenders = files.filter((f) => /^import (?!type )[^;]*from '@studify\/shared'/m.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
