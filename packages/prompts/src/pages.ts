// Page-number helpers. Model output always uses ORIGINAL page numbers (the numbers printed
// in the "páginas originais" label of each document block). These helpers validate that the
// numbers actually belong to what was sent, before anything is stored.

export function formatPageList(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const page of sorted) {
    if (start === undefined) {
      start = page;
      prev = page;
      continue;
    }
    if (page === (prev as number) + 1) {
      prev = page;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = page;
    prev = page;
  }
  if (start !== undefined) runs.push(start === prev ? `${start}` : `${start}–${prev}`);
  return runs.join(', ');
}

export interface PageRefLike {
  doc: string;
  page_start: number;
  page_end: number;
}

/** Returns human-readable issues; an empty array means every referenced page was sent. */
export function checkPageRefs(refs: readonly PageRefLike[], allowed: Record<string, readonly number[]>): string[] {
  const issues: string[] = [];
  for (const ref of refs) {
    const pages = allowed[ref.doc];
    if (!pages) {
      issues.push(`documento desconhecido: ${ref.doc}`);
      continue;
    }
    if (ref.page_end < ref.page_start) {
      issues.push(`intervalo invertido em ${ref.doc}: ${ref.page_start}–${ref.page_end}`);
      continue;
    }
    for (let page = ref.page_start; page <= ref.page_end; page += 1) {
      if (!pages.includes(page)) {
        issues.push(`página ${page} de ${ref.doc} não foi enviada`);
        break;
      }
    }
  }
  return issues;
}

/** Same check for plain page numbers (single-document tasks, page text blocks). */
export function checkPageNumbers(pages: readonly number[], allowed: readonly number[]): string[] {
  return pages.filter((p) => !allowed.includes(p)).map((p) => `página ${p} não foi enviada`);
}
