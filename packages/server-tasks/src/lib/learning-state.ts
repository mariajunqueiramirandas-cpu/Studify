// Loads what the learning engine needs for one user (evidence, cards, card states, the knowledge
// tree) and computes mastery per node with @studify/shared (learning-engine §5). Pure computation
// lives in `computeMasteries`; `loadLearningData` is the only function that reads the database.
import {
  DEFAULT_LEARNING_PARAMS,
  ancestorsOf,
  decayFactor,
  masteryAt,
  resolveParams,
  type CardState,
  type EvidenceAggregate,
  type LearningParams,
  type MasteryResult,
} from '@studify/shared';
import type { OperationContext } from '../framework/types.ts';
import { IN_CHUNK, chunk, fetchAll, unwrapRows, uniq } from './db.ts';

export interface NodeInfo {
  id: string;
  subjectId: string;
  parentId: string | null;
  kind: 'unit' | 'topic' | 'concept';
  title: string;
  position: number;
  isPlaceholder: boolean;
}

/** One stored evidence row (mastery_evidence). `weight` already includes type, source and confidence (§5.2). */
export interface EvidencePoint {
  nodeId: string;
  weight: number;
  outcome: number;
  occurredAt: Date;
  /** question evidence is counted; every row here is question-type evidence. */
  refType: string;
}

export interface CardPoint {
  cardId: string;
  subjectId: string;
  nodeId: string | null;
  conceptId: string | null;
  state: CardState;
}

export interface LearningData {
  nodes: Map<string, NodeInfo>;
  parentOf: Record<string, string | null>;
  evidence: EvidencePoint[];
  cards: CardPoint[];
}

export interface NodeMastery extends MasteryResult {
  /** λ_n (§5.1): 0.5 with cards and questions, 1 cards only, 0 questions only, null with neither. */
  lambda: number | null;
  hasCards: boolean;
  hasQuestions: boolean;
  /** Question evidence events folded into the node (roll-up included). */
  questionCount: number;
}

const STATE_KINDS = ['new', 'learning', 'review', 'relearning'] as const;

export function toCardState(row: {
  card_id: string;
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  learning_steps: number;
  state: number;
  last_review: string | null;
  suspended: boolean;
}): CardState {
  return {
    cardId: row.card_id,
    state: STATE_KINDS[row.state] ?? 'new',
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    reps: row.reps,
    lapses: row.lapses,
    scheduledDays: row.scheduled_days,
    learningSteps: row.learning_steps,
    lastReview: row.last_review ? new Date(row.last_review) : null,
    suspended: row.suspended,
  };
}

/** Folds one already-weighted evidence point into an aggregate (same rule as foldEvidence, §5.3). */
export function foldWeighted(agg: EvidenceAggregate, weight: number, outcome: number, at: Date): EvidenceAggregate {
  const ws = weight * outcome;
  if (agg.updatedAt === null) return { sumW: weight, sumWS: ws, count: agg.count + 1, updatedAt: at };
  const ref = agg.updatedAt.getTime();
  const t = at.getTime();
  if (t >= ref) {
    const k = decayFactor(t - ref);
    return { sumW: agg.sumW * k + weight, sumWS: agg.sumWS * k + ws, count: agg.count + 1, updatedAt: at };
  }
  const k = decayFactor(ref - t);
  return { sumW: agg.sumW + weight * k, sumWS: agg.sumWS + ws * k, count: agg.count + 1, updatedAt: agg.updatedAt };
}

function emptyAgg(): EvidenceAggregate {
  return { sumW: 0, sumWS: 0, count: 0, updatedAt: null };
}

function chainOf(nodeId: string, parentOf: Record<string, string | null>): string[] {
  return [nodeId, ...ancestorsOf(nodeId, parentOf)];
}

/**
 * Mastery per node at instant `at` (§5.1). Evidence rolls up to every ancestor; cards pool from the
 * node's subtree (their topic and concept). Nodes without any evidence or card get mastery null.
 */
export function computeMasteries(data: LearningData, at: Date, params: LearningParams = DEFAULT_LEARNING_PARAMS as LearningParams): Map<string, NodeMastery> {
  const aggs = new Map<string, EvidenceAggregate>();
  for (const point of data.evidence) {
    for (const nodeId of chainOf(point.nodeId, data.parentOf)) {
      aggs.set(nodeId, foldWeighted(aggs.get(nodeId) ?? emptyAgg(), point.weight, point.outcome, point.occurredAt));
    }
  }

  const cardsByNode = new Map<string, CardState[]>();
  for (const card of data.cards) {
    const nodes = new Set<string>();
    if (card.nodeId) for (const id of chainOf(card.nodeId, data.parentOf)) nodes.add(id);
    if (card.conceptId) for (const id of chainOf(card.conceptId, data.parentOf)) nodes.add(id);
    for (const id of nodes) {
      const list = cardsByNode.get(id) ?? [];
      list.push(card.state);
      cardsByNode.set(id, list);
    }
  }

  const ids = uniq([...aggs.keys(), ...cardsByNode.keys(), ...data.nodes.keys()]);
  const out = new Map<string, NodeMastery>();
  for (const id of ids) {
    const agg = aggs.get(id) ?? null;
    const cards = cardsByNode.get(id) ?? [];
    const result = masteryAt({ agg, cards }, at, params);
    const hasCards = result.retrievabilitySource === 'cards';
    const hasQuestions = (agg?.count ?? 0) > 0;
    const lambda = hasCards && hasQuestions ? 0.5 : hasCards ? 1 : hasQuestions ? 0 : null;
    out.set(id, { ...result, lambda, hasCards, hasQuestions, questionCount: agg?.count ?? 0 });
  }
  return out;
}


/** Subjects the user can learn from: personal subjects plus shared subjects of active Turmas. */
export async function userSubjectIds(ctx: OperationContext, userId: string): Promise<string[]> {
  const personal = unwrapRows(
    await ctx.supabase.from('subjects').select('id').eq('owner_profile_id', userId).is('deleted_at', null),
    'subjects',
  );
  const memberships = unwrapRows(
    await ctx.supabase.from('class_group_members').select('class_group_id').eq('user_id', userId).eq('status', 'active'),
    'class_group_members',
  );
  const groupIds = uniq(memberships.map((m: { class_group_id: string }) => m.class_group_id));
  const shared: Array<{ id: string }> = [];
  for (const part of chunk(groupIds, IN_CHUNK)) {
    shared.push(...unwrapRows(await ctx.supabase.from('subjects').select('id').in('owner_class_group_id', part).is('deleted_at', null), 'subjects'));
  }
  return uniq([...personal.map((s: { id: string }) => s.id), ...shared.map((s) => s.id)]);
}

/** Loads the user's learning inputs for the given subjects. Reads only; nothing is written. */
export async function loadLearningData(ctx: OperationContext, userId: string, subjectIds: readonly string[]): Promise<LearningData> {
  const nodes = new Map<string, NodeInfo>();
  const parentOf: Record<string, string | null> = {};
  for (const part of chunk([...subjectIds], IN_CHUNK)) {
    const rows = unwrapRows<{
      id: string;
      subject_id: string;
      parent_id: string | null;
      kind: NodeInfo['kind'];
      title: string;
      position: number;
      is_placeholder: boolean;
    }>(await ctx.supabase.from('knowledge_nodes').select('id,subject_id,parent_id,kind,title,position,is_placeholder').in('subject_id', part).is('deleted_at', null), 'knowledge_nodes');
    for (const r of rows) {
      nodes.set(r.id, {
        id: r.id,
        subjectId: r.subject_id,
        parentId: r.parent_id,
        kind: r.kind,
        title: r.title,
        position: r.position,
        isPlaceholder: r.is_placeholder,
      });
      parentOf[r.id] = r.parent_id;
    }
  }

  const evidenceRows = await fetchAll<{ node_id: string; weight: number; outcome: number; occurred_at: string; ref_type: string }>(
    (from, to) =>
      ctx.supabase.from('mastery_evidence').select('node_id,weight,outcome,occurred_at,ref_type').eq('user_id', userId).order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
        data: Array<{ node_id: string; weight: number; outcome: number; occurred_at: string; ref_type: string }> | null;
        error: { message: string } | null;
      }>,
    'mastery_evidence',
  );
  const evidence: EvidencePoint[] = evidenceRows.map((r) => ({
    nodeId: r.node_id,
    weight: Number(r.weight),
    outcome: Number(r.outcome),
    occurredAt: new Date(r.occurred_at),
    refType: r.ref_type,
  }));

  const cards: CardPoint[] = [];
  if (subjectIds.length > 0) {
    const cardRows: Array<{ id: string; subject_id: string; node_id: string; concept_id: string | null; personal_for_user_id: string | null }> = [];
    for (const part of chunk([...subjectIds], IN_CHUNK)) {
      cardRows.push(
        ...unwrapRows(
          await ctx.supabase.from('cards').select('id,subject_id,node_id,concept_id,personal_for_user_id').in('subject_id', part).is('deleted_at', null).eq('status', 'active'),
          'cards',
        ),
      );
    }
    const visible = cardRows.filter((c) => c.personal_for_user_id === null || c.personal_for_user_id === userId);
    const stateById = new Map<string, CardState>();
    for (const part of chunk(
      visible.map((c) => c.id),
      IN_CHUNK,
    )) {
      const rows = unwrapRows<Parameters<typeof toCardState>[0]>(
        await ctx.supabase
          .from('card_states')
          .select('card_id,due,stability,difficulty,reps,lapses,scheduled_days,learning_steps,state,last_review,suspended')
          .eq('user_id', userId)
          .in('card_id', part),
        'card_states',
      );
      for (const row of rows) stateById.set(row.card_id, toCardState(row));
    }
    for (const card of visible) {
      const state = stateById.get(card.id);
      if (!state) continue;
      cards.push({ cardId: card.id, subjectId: card.subject_id, nodeId: card.node_id, conceptId: card.concept_id, state });
    }
  }
  return { nodes, parentOf, evidence, cards };
}

/** Params for a user: defaults, with the retention target from profiles.settings.memory when set. */
export function paramsFor(retention: number | null | undefined, timeZone: string): LearningParams {
  return resolveParams({
    timeZone,
    ...(retention !== null && retention !== undefined ? { requestRetention: retention } : {}),
  });
}

