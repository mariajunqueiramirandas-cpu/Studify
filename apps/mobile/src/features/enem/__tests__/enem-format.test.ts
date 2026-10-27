import { areaRows, bookletPosition, daysUntil, editorLines, enemRoute, masteryTone, scalePos, skillGrid } from '../format';

describe('ENEM screen helpers', () => {
  it('groups H1–H30 by competência with accuracy per skill', () => {
    const grid = skillGrid('MT', new Map([['MT-H21', { n: 4, correct: 3 }]]));
    expect(grid).toHaveLength(7);
    expect(grid.flatMap((g) => g.skills)).toHaveLength(30);
    const c5 = grid[4]!;
    expect(c5.competency).toBe(5);
    expect(c5.skills.map((s) => s.skill)).toEqual([19, 20, 21, 22, 23]);
    expect(c5.skills.find((s) => s.code === 'MT-H21')).toMatchObject({ accuracy: 0.75, answered: 4 });
  });

  it('colors skills only with enough evidence', () => {
    expect(masteryTone({ accuracy: 0.9, answered: 2 })).toBe('none');
    expect(masteryTone({ accuracy: 0.4, answered: 5 })).toBe('low');
    expect(masteryTone({ accuracy: 0.6, answered: 5 })).toBe('mid');
    expect(masteryTone({ accuracy: 0.8, answered: 5 })).toBe('high');
    expect(masteryTone({ accuracy: null, answered: 0 })).toBe('none');
  });

  it('places scores on the 300–900 display scale and counts days', () => {
    expect(scalePos(600)).toBe(0.5);
    expect(scalePos(200)).toBe(0);
    expect(scalePos(1000)).toBe(1);
    expect(daysUntil('2027-11-07', '2027-11-01')).toBe(6);
    expect(daysUntil('2027-10-31', '2027-11-01')).toBe(-1);
  });

  it('counts editor lines like the server (≤ 7 is zero, > 30 is a warning)', () => {
    expect(editorLines('a'.repeat(75 * 7))).toEqual({ lines: 7, tooShort: true, tooLong: false });
    expect(editorLines(`${'a'.repeat(75 * 20)}\n${'b'.repeat(75 * 11)}`)).toEqual({ lines: 31, tooShort: false, tooLong: true });
  });

  it('lists simulado areas in ENEM order with coherence counts', () => {
    const area = (score: number) => ({
      theta: 0,
      se: 0.3,
      score,
      ci80_low: score - 40,
      ci80_high: score + 40,
      n_items: 45,
      n_correct: 30,
      n_blank: 2,
      coherence: { lz: -0.5, level: 'alta' as const, easy_miss_ids: ['a'], lucky_hit_ids: [] },
      time: { total_s: 100, per_item_s: [], stuck_ids: ['x', 'y'] },
    });
    const rows = areaRows({ areas: { MT: area(650), LC: area(600) } });
    expect(rows.map((r) => r.area)).toEqual(['LC', 'MT']);
    expect(rows[1]).toMatchObject({ score: 650, low: 610, high: 690, easyMisses: 1, stuck: 2, blank: 2 });
    expect(areaRows(null)).toEqual([]);
    expect(bookletPosition([{ position: 136 }])).toBe(136);
    expect(bookletPosition(null)).toBeNull();
  });
});

describe('enemRoute', () => {
  it('opens the simulado setup with the planned mode', () => {
    expect(enemRoute({ unitType: 'mock', reasonKey: 'enem.plan.mock_day1', reasonParams: { mock: { mode: 'day1', part: 1, parts: 1 } } })).toEqual({ pathname: '/enem/simulado/new', params: { mode: 'full_day1' } });
    expect(enemRoute({ unitType: 'mock', reasonKey: 'enem.plan.mock_area', reasonParams: { area: 'MT', mock: { mode: 'area', area: 'MT', part: 1, parts: 2 } } })).toEqual({ pathname: '/enem/simulado/new', params: { mode: 'area', area: 'MT' } });
  });

  it('routes essays, the véspera and bank practice', () => {
    expect(enemRoute({ unitType: 'essay', reasonKey: 'enem.plan.essay', reasonParams: {} })?.pathname).toBe('/enem/essay/new');
    expect(enemRoute({ unitType: 'vespera', reasonKey: 'enem.plan.vespera', reasonParams: { area: 'CN' } })?.pathname).toBe('/enem/reta-final');
    expect(enemRoute({ unitType: 'practice', reasonKey: 'enem.plan.practice', reasonParams: { area: 'CH', enemTopicId: 't1' } })).toEqual({ pathname: '/enem/bank', params: { area: 'CH', topicId: 't1' } });
  });

  it('leaves school items and ENEM learn units to the normal flow', () => {
    expect(enemRoute({ unitType: 'practice', reasonKey: 'plan.reason.weak', reasonParams: null })).toBeNull();
    expect(enemRoute({ unitType: 'learn', reasonKey: 'enem.plan.learn', reasonParams: { area: 'MT' } })).toBeNull();
    expect(enemRoute({ unitType: 'practice', reasonKey: 'enem.plan.practice', reasonParams: {} })).toBeNull();
  });
});
