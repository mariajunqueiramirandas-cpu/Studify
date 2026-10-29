/** The stable code of an ApiError (or any error carrying `code`), or '' when there is none. */
export function errorCode(e: unknown): string {
  return (e as { code?: string } | null)?.code ?? '';
}
