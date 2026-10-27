// Auto visuals (LRN-05). The AI returns a JSON spec, never an image (LRN-05.3); these functions check the size
// limits (LRN-05.6) and the structure, and lay the spec out deterministically for the native renderer.
import { compareStrings } from './util.ts';

export interface VisualNode {
  id: string;
  label: string;
  detail?: string | null;
}

export type VisualSpecShape =
  | { type: 'flowchart'; nodes: VisualNode[]; edges: Array<{ from: string; to: string; label?: string | null }> }
  | { type: 'cycle'; nodes: VisualNode[] }
  | { type: 'timeline'; events: Array<{ id: string; date_label: string; sort_key: number; title: string; detail?: string | null }> }
  | { type: 'comparison_table'; columns: Array<{ id: string; label: string }>; rows: Array<{ criterion: string; cells: string[] }> }
  | { type: 'hierarchy'; nodes: Array<VisualNode & { parent_id: string | null }> };

/** LRN-05.6 size limits. */
export const VISUAL_LIMITS = {
  flowchartNodes: 12,
  cycleNodes: 12,
  timelineEvents: 15,
  comparisonColumns: 4,
  comparisonRows: 8,
  hierarchyLevels: 4,
  hierarchyNodes: 20,
} as const;

function depthMap(nodes: ReadonlyArray<{ id: string; parent_id: string | null }>): Map<string, number> | null {
  const parent = new Map(nodes.map((n) => [n.id, n.parent_id]));
  const out = new Map<string, number>();
  for (const n of nodes) {
    let d = 1;
    let cur = n.parent_id;
    const seen = new Set([n.id]);
    while (cur !== null) {
      if (seen.has(cur) || !parent.has(cur)) return null; // cycle or dangling parent
      seen.add(cur);
      d += 1;
      cur = parent.get(cur) ?? null;
    }
    out.set(n.id, d);
  }
  return out;
}

/** Problems with a spec; empty when it can be rendered (LRN-05.6 limits plus structural checks). */
export function visualSpecErrors(spec: VisualSpecShape): string[] {
  const errors: string[] = [];
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  switch (spec.type) {
    case 'flowchart': {
      if (spec.nodes.length < 2 || spec.nodes.length > VISUAL_LIMITS.flowchartNodes) errors.push('flowchart_nodes');
      if (!unique(spec.nodes.map((n) => n.id))) errors.push('duplicate_ids');
      const ids = new Set(spec.nodes.map((n) => n.id));
      if (spec.edges.some((e) => !ids.has(e.from) || !ids.has(e.to) || e.from === e.to)) errors.push('edge_endpoints');
      if (spec.edges.length === 0) errors.push('no_edges');
      break;
    }
    case 'cycle':
      if (spec.nodes.length < 3 || spec.nodes.length > VISUAL_LIMITS.cycleNodes) errors.push('cycle_nodes');
      if (!unique(spec.nodes.map((n) => n.id))) errors.push('duplicate_ids');
      break;
    case 'timeline':
      if (spec.events.length < 2 || spec.events.length > VISUAL_LIMITS.timelineEvents) errors.push('timeline_events');
      if (!unique(spec.events.map((e) => e.id))) errors.push('duplicate_ids');
      break;
    case 'comparison_table':
      if (spec.columns.length < 2 || spec.columns.length > VISUAL_LIMITS.comparisonColumns) errors.push('comparison_columns');
      if (spec.rows.length < 1 || spec.rows.length > VISUAL_LIMITS.comparisonRows) errors.push('comparison_rows');
      if (spec.rows.some((r) => r.cells.length !== spec.columns.length)) errors.push('comparison_cells');
      break;
    case 'hierarchy': {
      if (spec.nodes.length < 2 || spec.nodes.length > VISUAL_LIMITS.hierarchyNodes) errors.push('hierarchy_nodes');
      if (!unique(spec.nodes.map((n) => n.id))) errors.push('duplicate_ids');
      if (spec.nodes.filter((n) => n.parent_id === null).length !== 1) errors.push('hierarchy_root');
      const depths = depthMap(spec.nodes);
      if (!depths) errors.push('hierarchy_structure');
      else if (Math.max(...depths.values()) > VISUAL_LIMITS.hierarchyLevels) errors.push('hierarchy_levels');
      break;
    }
  }
  return errors;
}

export interface PlacedNode {
  id: string;
  /** Column (flowchart layer, hierarchy depth) or angle index (cycle). */
  x: number;
  y: number;
}

/**
 * Flowchart layers (longest path from a source) top to bottom, nodes of a layer left to right in spec order.
 * Back edges (loops in a process) do not push a node down, so the layout always terminates.
 */
export function flowchartLayout(spec: Extract<VisualSpecShape, { type: 'flowchart' }>): PlacedNode[] {
  const order = new Map(spec.nodes.map((n, i) => [n.id, i]));
  const forward = spec.edges.filter((e) => (order.get(e.from) ?? 0) < (order.get(e.to) ?? 0));
  const layer = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const n of spec.nodes) {
    for (const e of forward.filter((x) => x.from === n.id)) layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(n.id) ?? 0) + 1));
  }
  const perLayer = new Map<number, number>();
  return spec.nodes.map((n) => {
    const y = layer.get(n.id) ?? 0;
    const x = perLayer.get(y) ?? 0;
    perLayer.set(y, x + 1);
    return { id: n.id, x, y };
  });
}

/** Cycle positions on a unit circle, starting at the top and going clockwise. */
export function cycleLayout(count: number): Array<{ x: number; y: number; angle: number }> {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    return { x: Math.cos(angle), y: Math.sin(angle), angle };
  });
}

/** Tidy tree: depth is the row, leaves take consecutive columns and parents center over their children. */
export function hierarchyLayout(spec: Extract<VisualSpecShape, { type: 'hierarchy' }>): PlacedNode[] {
  const children = new Map<string | null, string[]>();
  spec.nodes.forEach((n) => children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.id]));
  const out = new Map<string, PlacedNode>();
  let nextLeaf = 0;
  const place = (id: string, depth: number, guard: Set<string>): number => {
    if (guard.has(id)) return nextLeaf;
    guard.add(id);
    const kids = children.get(id) ?? [];
    let x: number;
    if (kids.length === 0) x = nextLeaf++;
    else {
      const xs = kids.map((k) => place(k, depth + 1, guard));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    out.set(id, { id, x, y: depth });
    return x;
  };
  for (const root of children.get(null) ?? []) place(root, 0, new Set());
  return spec.nodes.map((n) => out.get(n.id) ?? { id: n.id, x: nextLeaf++, y: 0 });
}

/** Timeline events in chronological order (stable on ties). */
export function timelineOrder<T extends { sort_key: number; id: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => a.sort_key - b.sort_key || compareStrings(a.id, b.id));
}
