// LRN-05: maps the model's visual (doc labels, `source` per item) to the stored spec (document ids,
// `source_pages` per item) and checks it with the same rules the renderer relies on (LRN-05.6).
import type { VisualOutput } from '@studify/prompts';
import { VisualSpecSchema, visualSpecErrors, type VisualSpec, type VisualSpecShape } from '@studify/shared';

type Ref = { doc: string; page_start: number; page_end: number } | null;
type Stored = Array<{ document_id: string; page_start: number; page_end: number }>;

function pages(ref: Ref, labels: Record<string, string>): Stored {
  if (!ref || !labels[ref.doc]) return [];
  return [{ document_id: labels[ref.doc]!, page_start: ref.page_start, page_end: ref.page_end }];
}

function withSources<T extends { source: Ref }>(item: T, labels: Record<string, string>) {
  const { source, ...rest } = item;
  const sp = pages(source, labels);
  return { ...rest, ...(sp.length ? { source_pages: sp } : {}) };
}

/** The stored spec, or the list of problems when it cannot be rendered. */
export function toStoredSpec(visual: NonNullable<VisualOutput['visual']>, labels: Record<string, string>): { spec: VisualSpec; sourcePages: Stored } | { errors: string[] } {
  let spec: unknown;
  switch (visual.type) {
    case 'flowchart':
      spec = { type: 'flowchart', nodes: visual.nodes.map((n) => withSources(n, labels)), edges: visual.edges };
      break;
    case 'cycle':
      spec = { type: 'cycle', nodes: visual.nodes.map((n) => withSources(n, labels)) };
      break;
    case 'timeline':
      spec = { type: 'timeline', events: visual.events.map((e) => withSources(e, labels)) };
      break;
    case 'comparison_table':
      spec = { type: 'comparison_table', columns: visual.columns, rows: visual.rows.map((r) => withSources(r, labels)) };
      break;
    case 'hierarchy':
      spec = { type: 'hierarchy', nodes: visual.nodes.map((n) => withSources(n, labels)) };
      break;
  }
  const parsed = VisualSpecSchema.safeParse(spec);
  if (!parsed.success) return { errors: ['schema'] };
  const errors = visualSpecErrors(parsed.data as VisualSpecShape);
  if (errors.length) return { errors };
  const all: Stored = [];
  const seen = new Set<string>();
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (k === 'source_pages' && Array.isArray(child)) {
          for (const p of child as Stored) {
            const key = `${p.document_id}:${p.page_start}:${p.page_end}`;
            if (!seen.has(key)) {
              seen.add(key);
              all.push(p);
            }
          }
        } else collect(child);
      }
    }
  };
  collect(parsed.data);
  return { spec: parsed.data, sourcePages: all };
}
