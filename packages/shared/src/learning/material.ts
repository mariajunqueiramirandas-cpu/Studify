// Material checker findings (ING-06). The vote rule is enforced by vote_material_finding() in SQL; this mirror
// keeps the worker and the app consistent with it, and orders and caps what the student sees.
import { compareStrings } from './util.ts';

export type FindingSeverityName = 'low' | 'medium' | 'high';
export type FindingStatusName = 'open' | 'dismissed' | 'confirmed';

/** ING-06.5: at most 20 findings per document. */
export const MAX_FINDINGS_PER_DOCUMENT = 20;
/** ING-06.3: confirmations that show a Turma finding to everyone as confirmed. */
export const FINDING_CONFIRMATIONS = 2;

const SEVERITY_RANK: Record<FindingSeverityName, number> = { high: 0, medium: 1, low: 2 };

/** Mirror of vote_material_finding(): a personal subject follows its owner's vote; a Turma needs 2 votes. */
export function findingStatus(input: { shared: boolean; confirmations: number; dismissals: number; lastVote: 'is_error' | 'not_error' | null }): FindingStatusName {
  if (!input.shared) return input.lastVote === 'is_error' ? 'confirmed' : input.lastVote === 'not_error' ? 'dismissed' : 'open';
  if (input.confirmations >= FINDING_CONFIRMATIONS) return 'confirmed';
  if (input.dismissals >= FINDING_CONFIRMATIONS && input.dismissals > input.confirmations) return 'dismissed';
  return 'open';
}

export interface FindingLike {
  severity: FindingSeverityName;
  page_start: number;
  description: string;
}

/** ING-06.5: by severity, then page; capped at 20. */
export function rankFindings<T extends FindingLike>(findings: readonly T[]): T[] {
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.page_start - b.page_start || compareStrings(a.description, b.description))
    .slice(0, MAX_FINDINGS_PER_DOCUMENT);
}

/** What "Avisos do material" lists: low severity only on request; never the ones this student dismissed. */
export function visibleFindings<T extends FindingLike & { id: string; status: FindingStatusName }>(
  findings: readonly T[],
  opts: { showLow: boolean; myVotes: ReadonlyMap<string, 'is_error' | 'not_error'> },
): T[] {
  return rankFindings(findings).filter(
    (f) => f.status !== 'dismissed' && opts.myVotes.get(f.id) !== 'not_error' && (opts.showLow || f.severity !== 'low'),
  );
}
