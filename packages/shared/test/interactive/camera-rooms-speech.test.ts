import { describe, expect, it } from 'vitest';
import {
  applyRoomTimerAction,
  advanceRoomTimer,
  assessImageQuality,
  cameraAttemptEvidence,
  canReact,
  decideTopicMatch,
  editRatio,
  fitLongEdge,
  hintLadderLength,
  imageStats,
  laplacianVariance,
  masksToRender,
  maxCapturePages,
  normalizeMask,
  occlusionCardText,
  occlusionCardsFor,
  parseTranscriptionMarkers,
  pixelateRegions,
  roomGoalProgress,
  roomShouldClose,
  roomTimerView,
  speakableText,
  splitSentences,
  spokenLatex,
  stripTranscriptionMarkers,
  suggestMasks,
  validTimerConfig,
  type RoomTimerState,
} from '../../src/interactive/index.ts';

function solid(width: number, height: number, value: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return rgba;
}

describe('capture quality (spec 11 §8.1)', () => {
  it('flags blur, darkness and glare with the spec thresholds', () => {
    expect(assessImageQuality({ laplacianVariance: 79, meanLuminance: 59, glareRatio: 0.05 })).toEqual(['blur', 'dark', 'glare']);
    expect(assessImageQuality({ laplacianVariance: 200, meanLuminance: 140, glareRatio: 0.01, tiltDegrees: 20 })).toEqual(['tilt']);
    expect(assessImageQuality({ laplacianVariance: 200, meanLuminance: 140, glareRatio: 0.01 })).toEqual([]);
  });

  it('measures a flat image as blurry and a checkerboard as sharp', () => {
    const flat = solid(32, 32, 128);
    expect(imageStats(flat, 32, 32)).toMatchObject({ laplacianVariance: 0, meanLuminance: 128, glareRatio: 0 });
    const gray = new Uint8Array(32 * 32).map((_v, i) => ((i % 32) + Math.floor(i / 32)) % 2 === 0 ? 0 : 255);
    expect(laplacianVariance(gray, 32, 32)).toBeGreaterThan(80);
    expect(imageStats(solid(4, 4, 255), 4, 4).glareRatio).toBe(1);
  });

  it('fits the long edge without upscaling and limits pages by intent', () => {
    expect(fitLongEdge(4000, 3000)).toEqual({ width: 1568, height: 1176 });
    expect(fitLongEdge(800, 600)).toEqual({ width: 800, height: 600 });
    expect(maxCapturePages('explain')).toBe(2);
    expect(maxCapturePages('add_to_subject')).toBe(20);
    expect(maxCapturePages('grade_essay')).toBe(20);
  });

  it('pixelates face regions in place (CAM-00.6)', () => {
    const width = 20;
    const height = 20;
    const rgba = new Uint8Array(width * height * 4).map((_v, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    const before = rgba.slice();
    pixelateRegions(rgba, width, height, [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }], 4);
    const at = (x: number, y: number) => rgba[(y * width + x) * 4];
    // Inside one cell every pixel has the same colour; outside the grown box nothing changed.
    expect(at(8, 8)).toBe(at(9, 9));
    expect(rgba[(0 * width + 0) * 4]).toBe(before[0]);
  });
});

describe('transcription (CAM-03.3–03.5)', () => {
  it('computes the edit ratio', () => {
    expect(editRatio('abc', 'abc')).toBe(0);
    expect(editRatio('', '')).toBe(0);
    expect(editRatio('casa', 'caza')).toBe(0.25);
    expect(editRatio('a', 'xyz')).toBe(1);
  });

  it('parses and strips markers', () => {
    const text = 'O ⟦exodo?|êxodo⟧ rural ⟦ilegível⟧ e ⟦rasura⟧ fim ⟦cidade?⟧.';
    expect(parseTranscriptionMarkers(text)).toMatchObject({
      illegible: 1,
      crossedOut: 1,
      uncertain: [
        { word: 'exodo', alternatives: ['êxodo'] },
        { word: 'cidade', alternatives: [] },
      ],
    });
    expect(stripTranscriptionMarkers(text)).toBe('O exodo rural e fim cidade.');
  });
});

describe('course match and hint ladder (§8.3, §8.5)', () => {
  it('accepts a clear winner, asks for a tie-break when close, gives up below threshold', () => {
    expect(decideTopicMatch([{ node_id: 'a', score: 0.8 }, { node_id: 'b', score: 0.5 }])).toEqual({ kind: 'matched', node_id: 'a', confidence: 0.8 });
    expect(decideTopicMatch([{ node_id: 'a', score: 0.8 }, { node_id: 'b', score: 0.75 }])).toEqual({ kind: 'ambiguous', candidates: ['a', 'b'] });
    expect(decideTopicMatch([{ node_id: 'a', score: 0.3 }])).toEqual({ kind: 'none' });
    expect(decideTopicMatch([])).toEqual({ kind: 'none' });
  });

  it('shortens the ladder for trivial questions and classifies attempts (CAM-02.10)', () => {
    expect(hintLadderLength(false)).toBe(4);
    expect(hintLadderLength(true)).toBe(2);
    expect(cameraAttemptEvidence(true, 1, false)).toEqual({ solutionViewed: false, score: 1 });
    expect(cameraAttemptEvidence(true, 3, false)).toEqual({ solutionViewed: true, score: 1 });
    expect(cameraAttemptEvidence(false, 0, false)).toEqual({ solutionViewed: false, score: 0 });
  });
});

describe('image occlusion (MEM-03)', () => {
  it('suggests masks from text boxes in reading order', () => {
    const masks = suggestMasks(
      [
        { text: 'núcleo', frame: { left: 200, top: 100, width: 80, height: 20 } },
        { text: 'mitocôndria', frame: { left: 10, top: 50, width: 100, height: 20 } },
        { text: 'x', frame: { left: 0, top: 0, width: 5, height: 5 } },
        { text: 'uma frase muito longa que não é um rótulo de figura', frame: { left: 0, top: 300, width: 300, height: 20 } },
      ],
      400,
      400,
    );
    expect(masks.map((m) => m.label)).toEqual(['mitocôndria', 'núcleo']);
    expect(masks[0]).toMatchObject({ id: 'm1', x: 0.025, y: 0.125, w: 0.25, h: 0.05 });
  });

  it('clamps masks and drops degenerate ones', () => {
    expect(normalizeMask({ id: 'm', label: 'a', x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toMatchObject({ w: expect.closeTo(0.1, 6), h: expect.closeTo(0.1, 6) });
    expect(normalizeMask({ id: 'm', label: 'a', x: 0.1, y: 0.1, w: 0.001, h: 0.5 })).toBeNull();
  });

  it('makes one card per labeled mask and renders hide_one / hide_all (MEM-03.3–03.5)', () => {
    const base = { path: 'media/s/card/1.webp', width: 800, height: 600 };
    const masks = [
      { id: 'a', label: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      { id: 'b', label: 'B', x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
      { id: 'c', label: '', x: 0.7, y: 0.7, w: 0.2, h: 0.1 },
    ];
    const cards = occlusionCardsFor(base, masks, 'hide_all');
    expect(cards.map((c) => c.target_mask_id)).toEqual(['a', 'b']);
    expect(occlusionCardText(cards[1]!)).toEqual({ front: 'O que está escondido na área destacada?', back: 'B' });
    expect(masksToRender(cards[0]!, false).map((r) => [r.mask.id, r.hidden, r.target])).toEqual([['a', true, true], ['b', true, false]]);
    expect(masksToRender(cards[0]!, true).map((r) => r.hidden)).toEqual([false, true]);
    const hideOne = { ...cards[0]!, mode: 'hide_one' as const };
    expect(masksToRender(hideOne, false).map((r) => r.hidden)).toEqual([true, false]);
  });
});

describe('study room timer (SOC-05.3)', () => {
  const config = { focus_min: 25, break_min: 5 };
  const t0 = new Date('2026-11-02T18:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const idle: RoomTimerState = { phase: 'idle', cycle: 0 };

  it('starts, rolls focus → break → focus and counts cycles', () => {
    const started = applyRoomTimerAction(idle, config, 'start', t0);
    expect(started).toMatchObject({ phase: 'focus', cycle: 0, ends_at: at(25).toISOString() });
    expect(roomTimerView(started, config, at(10))).toEqual({ phase: 'focus', remainingMs: 15 * 60_000, cycle: 0 });
    expect(advanceRoomTimer(started, config, at(26))).toMatchObject({ phase: 'break', cycle: 1, ends_at: at(30).toISOString() });
    expect(advanceRoomTimer(started, config, at(56))).toMatchObject({ phase: 'break', cycle: 2 });
    expect(advanceRoomTimer(started, config, at(61))).toMatchObject({ phase: 'focus', cycle: 2 });
  });

  it('pauses and resumes keeping the remaining time; skip ends the phase', () => {
    const started = applyRoomTimerAction(idle, config, 'start', t0);
    const paused = applyRoomTimerAction(started, config, 'pause', at(10));
    expect(paused).toMatchObject({ phase: 'paused', paused_phase: 'focus', remaining_ms: 15 * 60_000 });
    expect(roomTimerView(paused, config, at(40))).toMatchObject({ phase: 'paused', remainingMs: 15 * 60_000 });
    const resumed = applyRoomTimerAction(paused, config, 'resume', at(40));
    expect(resumed).toMatchObject({ phase: 'focus', ends_at: at(55).toISOString() });
    expect(applyRoomTimerAction(resumed, config, 'skip', at(41))).toMatchObject({ phase: 'break', cycle: 1 });
    expect(applyRoomTimerAction(idle, config, 'pause', t0)).toBe(idle);
  });

  it('validates configs, rate-limits reactions and closes rooms (SOC-05.5–05.6)', () => {
    expect(validTimerConfig({ focus_min: 50, break_min: 10 })).toBe(true);
    expect(validTimerConfig({ focus_min: 4, break_min: 10 })).toBe(false);
    expect(canReact(null, t0)).toBe(true);
    expect(canReact(new Date(t0.getTime() - 4000).toISOString(), t0)).toBe(false);
    expect(canReact(new Date(t0.getTime() - 5000).toISOString(), t0)).toBe(true);
    const room = { created_at: t0.toISOString(), last_active_at: t0.toISOString() };
    expect(roomShouldClose(room, 0, at(9))).toBe(false);
    expect(roomShouldClose(room, 0, at(10))).toBe(true);
    expect(roomShouldClose(room, 3, at(239))).toBe(false);
    expect(roomShouldClose(room, 3, at(240))).toBe(true);
    expect(roomGoalProgress([120, 90], 200)).toEqual({ progress: 200, target: 200, reached: true });
  });
});

describe('speech text (WEL-04.8, TUT-06.4)', () => {
  it.each([
    ['x^2 + 3', 'x ao quadrado mais 3'],
    ['a^3', 'a ao cubo'],
    ['2^{10}', '2 elevado a 10'],
    ['\\frac{a}{b} = 1', 'a sobre b igual a 1'],
    ['\\sqrt{16}', 'raiz quadrada de 16'],
    ['\\sqrt[3]{8}', 'raiz cúbica de 8'],
    ['\\Delta = b^2 - 4ac', 'delta igual a b ao quadrado menos 4 a c'],
    ['30^\\circ', '30 graus'],
    ['H_2O', 'H 2 O'],
    ['x \\leq 3,5', 'x menor ou igual a 3,5'],
  ])('%s → %s', (latex, spoken) => {
    expect(spokenLatex(latex)).toBe(spoken);
  });

  it('turns Markdown with math into speakable text', () => {
    const md = '## Bhaskara\n\nUse **sempre** $\\Delta = b^2 - 4ac$.\n\n- primeiro item\n- [link](http://x)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n[[APOIO]]';
    expect(speakableText(md)).toBe('Bhaskara.\nUse sempre delta igual a b ao quadrado menos 4 a c.\nprimeiro item\nlink\na, b.\n1, 2.');
  });

  it('splits sentences, keeping decimals and short abbreviations together', () => {
    expect(splitSentences('Olá! Veja a p. 12 do livro. O valor é 3.5 metros? Sim.')).toEqual([
      'Olá!',
      'Veja a p. 12 do livro.',
      'O valor é 3.5 metros?',
      'Sim.',
    ]);
  });
});
