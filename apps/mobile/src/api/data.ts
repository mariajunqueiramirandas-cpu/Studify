// The app's data calls (api.md §10, ADR 0012): what used to be a direct table query is a named API endpoint, answered
// over SSE like every call (callFunction). The server runs it as the signed-in student, under the same row level
// security, so results are what the direct query returned. Writes carry an Idempotency-Key, reused on retries.
import { callFunction, type CallOptions } from './functions';

export function data<T = unknown>(name: string, input: object = {}, options: CallOptions = {}): Promise<T> {
  return callFunction<object, T>(name, input, options);
}
