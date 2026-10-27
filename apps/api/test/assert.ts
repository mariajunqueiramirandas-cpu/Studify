// Stand-in for @std/assert (Deno). The suite uses a handful of assertions; they are implemented on
// node:assert/strict so the test bodies read the same as before the move from Deno.
import nodeAssert from 'node:assert/strict';

/** Deep equality, like @std/assert's assertEquals. */
export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notDeepStrictEqual(actual, expected, msg);
}

/** Truthy check, like @std/assert's assert. */
export function assert(expr: unknown, msg?: string): asserts expr {
  if (!expr) throw new nodeAssert.AssertionError({ message: msg ?? 'Expected a truthy value', actual: expr, expected: true, operator: '==' });
}

export function assertFalse(expr: unknown, msg?: string): void {
  if (expr) throw new nodeAssert.AssertionError({ message: msg ?? 'Expected a falsy value', actual: expr, expected: false, operator: '==' });
}

export function assertExists<T>(value: T, msg?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) throw new nodeAssert.AssertionError({ message: msg ?? 'Expected a value', actual: value, operator: '!=' });
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  nodeAssert.ok(actual.includes(expected), msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

export function assertMatch(actual: string, pattern: RegExp, msg?: string): void {
  nodeAssert.match(actual, pattern, msg);
}

export function assertInstanceOf<T>(actual: unknown, type: new (...args: never[]) => T, msg?: string): asserts actual is T {
  nodeAssert.ok(actual instanceof type, msg ?? `Expected an instance of ${type.name}`);
}

export function assertThrows(fn: () => unknown, ErrorClass?: new (...args: never[]) => Error, msgIncludes?: string): void {
  nodeAssert.throws(fn, (err: unknown) => {
    if (ErrorClass) nodeAssert.ok(err instanceof ErrorClass, `Expected ${ErrorClass.name}`);
    if (msgIncludes) nodeAssert.ok(err instanceof Error && err.message.includes(msgIncludes), `Expected message to include ${msgIncludes}`);
    return true;
  });
}

/** Resolves when `fn` rejects; the rejection (or its class and message fragment) is checked like @std/assert. */
export async function assertRejects(
  fn: () => Promise<unknown>,
  ErrorClass?: new (...args: never[]) => Error,
  msgIncludes?: string,
): Promise<unknown> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  nodeAssert.ok(caught !== undefined, 'Expected the promise to reject');
  if (ErrorClass) nodeAssert.ok(caught instanceof ErrorClass, `Expected ${ErrorClass.name}, got ${String(caught)}`);
  if (msgIncludes) nodeAssert.ok(caught instanceof Error && caught.message.includes(msgIncludes), `Expected message to include ${msgIncludes}`);
  return caught;
}
