// Keyset cursor for pulls (mobile-app.md §4.3 rule 6): (updated_at, ...pk) > cursor, lexicographically.
// Pure string building, so it is unit-tested without the Supabase client.
/** Lexicographic keyset condition for PostgREST `or`: (updated_at, ...pk) > cursor. */
export function cursorOrFilter(pk: string[], updatedAt: string, key: (string | number)[]): string {
  const quote = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  const ts = quote(updatedAt);
  const clauses = [`updated_at.gt.${ts}`];
  pk.forEach((column, i) => {
    const equalities = pk
      .slice(0, i)
      .map((c, j) => `${c}.eq.${quote(String(key[j]))}`)
      .map((e) => `,${e}`)
      .join('');
    clauses.push(`and(updated_at.eq.${ts}${equalities},${column}.gt.${quote(String(key[i]))})`);
  });
  return clauses.join(',');
}
