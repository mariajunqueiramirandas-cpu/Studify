import { describe, expect, it } from 'vitest';
import {
  TRAIL,
  checkpointBlueprint,
  checkpointSize,
  chapterFraction,
  conceptStates,
  nextTrailMove,
  normalizeTrailPlan,
  stableTopoOrder,
  trailNeeds,
  trailOutlineHash,
  trailProgress,
  type TrailChapter,
  type TrailMove,
  type TrailNeed,
  type TrailOutlineTopic,
  type TrailStepView,
} from '../../src/learning/index.ts';

const TOPICS: TrailOutlineTopic[] = [
  { id: 't1', title: 'Célula', order: 0, concepts: [{ id: 'c1', title: 'Membrana', order: 0 }, { id: 'c2', title: 'Núcleo', order: 1 }] },
  { id: 't2', title: 'Respiração', order: 1, concepts: [{ id: 'c3', title: 'Glicólise', order: 0 }, { id: 'c4', title: 'Krebs', order: 1 }] },
  { id: 't3', title: 'Fotossíntese', order: 2, concepts: [] },
];

describe('trail plan (spec 14 §8.1)', () => {
  it('falls back to the outline order with no proposal', () => {
    expect(normalizeTrailPlan([], TOPICS, [])).toEqual([
      { topicId: 't1', why: null, conceptIds: ['c1', 'c2'] },
      { topicId: 't2', why: null, conceptIds: ['c3', 'c4'] },
      { topicId: 't3', why: null, conceptIds: ['t3'] },
    ]);
  });

  it('keeps the model order, drops unknown and repeated ids, appends what it forgot', () => {
    const plan = normalizeTrailPlan(
      [
        { topicId: 't2', why: 'Base pra entender energia', conceptIds: ['c4', 'c4', 'x9', 'c1'] },
        { topicId: 'zz', why: 'inventado', conceptIds: [] },
        { topicId: 't2', why: 'repetido', conceptIds: [] },
        { topicId: 't1', why: 'Depois', conceptIds: ['c2'] },
      ],
      TOPICS,
      [],
    );
    expect(plan.map((c) => c.topicId)).toEqual(['t2', 't1', 't3']);
    expect(plan[0]).toEqual({ topicId: 't2', why: 'Base pra entender energia', conceptIds: ['c4', 'c3'] });
    expect(plan[1]!.conceptIds).toEqual(['c2', 'c1']);
  });

  it('repairs an order that puts a chapter before its prerequisite, including concept-level edges', () => {
    // Krebs (t2) needs Membrana (t1): t1 must come first even though the model put t2 first.
    const plan = normalizeTrailPlan(
      [
        { topicId: 't2', why: null, conceptIds: ['c4', 'c3'] },
        { topicId: 't1', why: null, conceptIds: [] },
      ],
      TOPICS,
      [
        { nodeId: 'c4', prerequisiteId: 'c1' },
        { nodeId: 'c4', prerequisiteId: 'c3' }, // inside t2: Glicólise before Krebs
      ],
    );
    expect(plan.map((c) => c.topicId)).toEqual(['t1', 't2', 't3']);
    expect(plan[1]!.conceptIds).toEqual(['c3', 'c4']);
  });

  it('breaks prerequisite cycles instead of dropping chapters', () => {
    const order = stableTopoOrder(['a', 'b', 'c'], new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]));
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
    expect(order).toHaveLength(3);
  });

  it('hashes the outline so a changed map is detected', () => {
    const same = trailOutlineHash([...TOPICS].reverse());
    expect(same).toBe(trailOutlineHash(TOPICS));
    const changed = trailOutlineHash([...TOPICS, { id: 't4', title: 'Novo', order: 3, concepts: [] }]);
    expect(changed).not.toBe(same);
  });
});

// A tiny simulator: content generation creates steps, the student answers with a script.
class Sim {
  steps: TrailStepView[] = [];
  #seq = 0;
  #served = 0;
  constructor(readonly chapter: TrailChapter) {}

  add(conceptId: string, purpose: TrailStepView['purpose'], round = 0, forStepId: string | null = null): TrailStepView {
    const step: TrailStepView = { id: `s${++this.#seq}`, conceptId, purpose, round, status: 'ready', correct: null, forStepId, createdSeq: this.#seq, servedSeq: null };
    this.steps.push(step);
    return step;
  }

  fulfil(need: TrailNeed) {
    if (need.kind === 'teach') {
      this.add(need.conceptId, 'lesson');
      for (let i = 0; i < TRAIL.practicePerLesson; i += 1) this.add(need.conceptId, 'practice');
    } else if (need.kind === 'remediate') {
      this.add(need.conceptId, 'remedial_lesson', need.round, need.forStepId);
      this.add(need.conceptId, 'remedial_question', need.round, need.forStepId);
    } else {
      for (const b of checkpointBlueprint(this.chapter, this.steps)) for (let i = 0; i < b.count; i += 1) this.add(b.conceptId, 'checkpoint', need.round);
    }
  }

  /** Runs until the chapter is passed; `answer` decides each question. Returns the served steps in order. */
  run(answer: (s: TrailStepView, n: number) => boolean, limit = 200): TrailStepView[] {
    const served: TrailStepView[] = [];
    for (let i = 0; i < limit; i += 1) {
      const move: TrailMove = nextTrailMove(this.chapter, this.steps);
      if (move.kind === 'chapter_passed') return served;
      if (move.kind === 'need') {
        this.fulfil(move.need);
        continue;
      }
      const step = this.steps.find((s) => s.id === move.stepId)!;
      step.servedSeq ??= ++this.#served;
      served.push(step);
      step.status = 'done';
      if (step.purpose !== 'lesson' && step.purpose !== 'remedial_lesson') step.correct = answer(step, served.length);
    }
    throw new Error('did not finish');
  }
}

const CH: TrailChapter = { topicId: 't1', why: null, conceptIds: ['c1', 'c2'] };

describe('next step (spec 14 §8.2)', () => {
  it('a student who gets everything right: lesson, two questions per concept, then the chapter test', () => {
    const sim = new Sim(CH);
    const served = sim.run(() => true);
    const labels = served.map((s) => `${s.conceptId}:${s.purpose}`);
    expect(labels.slice(0, 6)).toEqual(['c1:lesson', 'c1:practice', 'c1:practice', 'c2:lesson', 'c2:practice', 'c2:practice']);
    expect(labels.slice(6).sort()).toEqual(['c1:checkpoint', 'c1:checkpoint', 'c2:checkpoint', 'c2:checkpoint']);
    expect(labels).toHaveLength(6 + checkpointSize(2));
    // The spare question of each concept is never asked.
    expect(sim.steps.filter((s) => s.purpose === 'practice' && s.status === 'ready')).toHaveLength(2);
  });

  it('a wrong answer is followed by a re-explanation and a new question before moving on', () => {
    const sim = new Sim(CH);
    const served = sim.run((s, n) => !(s.conceptId === 'c1' && n === 2));
    expect(served.slice(0, 6).map((s) => s.purpose)).toEqual(['lesson', 'practice', 'remedial_lesson', 'remedial_question', 'practice', 'lesson']);
    expect(served[2]!.forStepId).toBe(served[1]!.id);
  });

  it('a concept that never clicks becomes shaky after 5 answers and weighs more in the test', () => {
    const sim = new Sim(CH);
    sim.run((s) => s.conceptId !== 'c1' || s.purpose === 'checkpoint');
    const c1Answers = sim.steps.filter((s) => s.conceptId === 'c1' && s.round === 0 && s.correct !== null);
    expect(c1Answers).toHaveLength(TRAIL.maxConceptQuestions);
    const test = sim.steps.filter((s) => s.purpose === 'checkpoint');
    expect(test.filter((s) => s.conceptId === 'c1').length).toBeGreaterThan(test.filter((s) => s.conceptId === 'c2').length);
  });

  it('a failed chapter test re-teaches the missed concepts and runs a new round', () => {
    const sim = new Sim(CH);
    // Round 1: every question on c1 wrong (2 of 4 right, below 70%); round 2: all right.
    const served = sim.run((s) => s.purpose !== 'checkpoint' || s.round !== 1 || s.conceptId === 'c2');
    const afterTest = served.slice(served.findIndex((s) => s.purpose === 'checkpoint'));
    const round1 = afterTest.filter((s) => s.purpose === 'checkpoint' && s.round === 1);
    const reteach = afterTest.filter((s) => s.round === 1 && s.purpose !== 'checkpoint');
    expect(round1.length).toBe(checkpointSize(2));
    expect(reteach.map((s) => `${s.conceptId}:${s.purpose}`)).toEqual(['c1:remedial_lesson', 'c1:remedial_question']);
    expect(afterTest.some((s) => s.purpose === 'checkpoint' && s.round === 2)).toBe(true);
  });

  it('resumes the step that was shown but not finished', () => {
    const sim = new Sim(CH);
    sim.fulfil({ kind: 'teach', conceptId: 'c1' });
    const lesson = sim.steps[0]!;
    lesson.servedSeq = 1;
    expect(nextTrailMove(CH, sim.steps)).toEqual({ kind: 'serve', stepId: lesson.id });
  });

  it('reports concept states for the path view', () => {
    const sim = new Sim(CH);
    sim.fulfil({ kind: 'teach', conceptId: 'c1' });
    expect(conceptStates(CH, sim.steps)).toEqual([
      { conceptId: 'c1', state: 'current' },
      { conceptId: 'c2', state: 'upcoming' },
    ]);
  });
});

describe('buffer (spec 14 §8.3)', () => {
  it('asks for the current concept now and the next one ahead', () => {
    expect(trailNeeds(CH, [], null)).toEqual([
      { need: { kind: 'teach', conceptId: 'c1' }, blocking: true, nextChapter: false },
      { need: { kind: 'teach', conceptId: 'c2' }, blocking: false, nextChapter: false },
    ]);
  });

  it('prepares the chapter test while on the last concept, and the next chapter during the test', () => {
    const sim = new Sim(CH);
    sim.fulfil({ kind: 'teach', conceptId: 'c1' });
    sim.fulfil({ kind: 'teach', conceptId: 'c2' });
    for (const s of sim.steps.filter((x) => x.conceptId === 'c1').slice(0, 3)) {
      s.status = 'done';
      s.servedSeq = s.createdSeq;
      if (s.purpose === 'practice') s.correct = true;
    }
    expect(trailNeeds(CH, sim.steps, null)).toEqual([{ need: { kind: 'checkpoint', round: 1 }, blocking: false, nextChapter: false }]);

    sim.fulfil({ kind: 'checkpoint', round: 1 });
    const next: TrailChapter = { topicId: 't2', why: null, conceptIds: ['c3', 'c4'] };
    for (const s of sim.steps.filter((x) => x.conceptId === 'c2' && x.purpose !== 'checkpoint').slice(0, 3)) {
      s.status = 'done';
      s.servedSeq = s.createdSeq;
      if (s.purpose === 'practice') s.correct = true;
    }
    expect(trailNeeds(CH, sim.steps, { chapter: next, steps: [] })).toEqual([{ need: { kind: 'teach', conceptId: 'c3' }, blocking: false, nextChapter: true }]);
    // Nothing more once the next chapter's first lesson exists.
    expect(trailNeeds(CH, sim.steps, { chapter: next, steps: [{ ...sim.steps[0]!, id: 'n1', conceptId: 'c3' }] })).toEqual([]);
  });

  it('writes the current lesson and the two concepts after it, and no more', () => {
    const big: TrailChapter = { topicId: 't', why: null, conceptIds: ['a', 'b', 'c', 'd'] };
    expect(trailNeeds(big, [], null)).toEqual([
      { need: { kind: 'teach', conceptId: 'a' }, blocking: true, nextChapter: false },
      { need: { kind: 'teach', conceptId: 'b' }, blocking: false, nextChapter: false },
      { need: { kind: 'teach', conceptId: 'c' }, blocking: false, nextChapter: false },
    ]);
  });
});

describe('progress', () => {
  it('counts concepts and the chapter test', () => {
    const sim = new Sim(CH);
    expect(chapterFraction(CH, sim.steps)).toBe(0);
    sim.run(() => true);
    expect(chapterFraction(CH, sim.steps)).toBe(1);
    expect(trailProgress(4, 1, 0.5)).toBeCloseTo(0.375);
    expect(trailProgress(4, 4, 0)).toBe(1);
    expect(trailProgress(0, 0, 0)).toBe(0);
  });

  it('sizes the chapter test from the concept count', () => {
    expect(checkpointSize(1)).toBe(4);
    expect(checkpointSize(3)).toBe(6);
    expect(checkpointSize(9)).toBe(10);
  });
});
