// Mapa da Memória and the prerequisite detective (learning-engine §16.1, §16.3; MEM-05, LRN-04).
import { clamp, mean } from './util.ts';

export type RetrievabilityBand = 'forte' | 'ok' | 'apagando' | 'quase_esquecido' | 'nao_estudado';

/** Labels shown next to the colour (MEM-05.2: icon and label, never colour alone). */
export const BAND_LABEL_PT: Readonly<Record<RetrievabilityBand, string>> = {
  forte: 'Forte',
  ok: 'Ok',
  apagando: 'Apagando',
  quase_esquecido: 'Quase esquecido',
  nao_estudado: 'Ainda não estudado',
};

/** Bands (MEM-05.2): Forte ≥ 0.90 · Ok 0.75–0.90 · Apagando 0.50–0.75 · Quase esquecido < 0.50. */
export function retrievabilityBand(r: number | null): RetrievabilityBand {
  if (r === null) return 'nao_estudado';
  if (r >= 0.9) return 'forte';
  if (r >= 0.75) return 'ok';
  if (r >= 0.5) return 'apagando';
  return 'quase_esquecido';
}

/** Glow opacity: R mapped linearly onto 20–100% (MEM-05.1). No glow for unstudied concepts. */
export function glowOpacity(r: number | null): number {
  if (r === null) return 0;
  return 0.2 + 0.8 * clamp(r, 0, 1);
}

/**
 * R_concept(t) (§16.1): mean card retrievability when the concept has introduced cards; otherwise the
 * question-based value when there are at least 3 evidence events ("baseado em questões", dashed).
 */
export function conceptRetrievability(input: {
  cardRetrievabilities: readonly number[];
  questionRetrievability: number | null;
  questionEvidenceCount: number;
}): { value: number | null; source: 'cards' | 'questions' | null } {
  const fromCards = mean(input.cardRetrievabilities);
  if (fromCards !== null) return { value: fromCards, source: 'cards' };
  if (input.questionEvidenceCount >= 3 && input.questionRetrievability !== null) {
    return { value: input.questionRetrievability, source: 'questions' };
  }
  return { value: null, source: null };
}

/**
 * R_topic(t) (§16.1): mean of its concepts' values, weighted by card count. Concepts without data are
 * excluded. When no concept has cards, the unweighted mean of the question-based values is used.
 * `null` means "Ainda não estudado".
 */
export function topicRetrievability(concepts: ReadonlyArray<{ value: number | null; cardCount: number }>): number | null {
  const withData = concepts.filter((c): c is { value: number; cardCount: number } => c.value !== null);
  if (withData.length === 0) return null;
  const weighted = withData.filter((c) => c.cardCount > 0);
  if (weighted.length > 0) {
    const total = weighted.reduce((s, c) => s + c.cardCount, 0);
    return weighted.reduce((s, c) => s + c.value * c.cardCount, 0) / total;
  }
  return mean(withData.map((c) => c.value));
}

// ---------- prerequisite detective (§16.3) ----------

export interface DetectiveNode {
  id: string;
  mastery: number | null;
  retrievability: number | null;
  evidenceCount: number;
  excluded: boolean;
  prerequisiteIds: readonly string[];
}

/**
 * For node N with evidence_count ≥ 5 and mastery < 0.5, pick the prerequisite that is most likely
 * the cause: not excluded, with mastery < 0.6 or retrievability < 0.7, lowest mastery first and then
 * lowest retrievability. Returns null when no nudge applies. The LRN-04.7 rate limits are the caller's.
 */
export function prerequisiteNudge(node: DetectiveNode, nodes: ReadonlyMap<string, DetectiveNode>): string | null {
  if (node.excluded || node.evidenceCount < 5) return null;
  if (node.mastery === null || node.mastery >= 0.5) return null;

  const candidates = node.prerequisiteIds
    .map((id) => nodes.get(id))
    .filter((p): p is DetectiveNode => p !== undefined && !p.excluded)
    .filter((p) => (p.mastery !== null && p.mastery < 0.6) || (p.retrievability !== null && p.retrievability < 0.7));

  const ranked = candidates.sort((a, b) => {
    const ma = a.mastery ?? 0;
    const mb = b.mastery ?? 0;
    if (ma !== mb) return ma - mb;
    const ra = a.retrievability ?? 0;
    const rb = b.retrievability ?? 0;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return ranked[0]?.id ?? null;
}
