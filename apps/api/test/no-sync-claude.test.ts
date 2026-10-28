import { test } from 'bun:test';
// ADR 0009: no request waits on Claude. A function whose code can reach a plain Claude call (callTask / callClaude),
// directly or through shared helpers, must either be deferred (it runs as a job) or declare `claudeInsideStream` (it
// makes the call inside its SSE producer, where the heartbeat flows). openStream is not a plain call. The check walks
// the relative imports of apps/api/src at module level, so a new helper path cannot slip by.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assertEquals } from './assert.ts';

const SRC = resolve(import.meta.dir, '../src');
/** Where callTask and callClaude are defined and wrapped; calling them from here is not a request path. */
const DEFINITIONS = new Set([join(SRC, 'shared/ai.ts')]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Runtime imports of a module, resolved to files (type-only imports carry no code). */
function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
    if (match[1]) continue;
    out.push(resolve(dirname(file), match[2]!));
  }
  return out;
}

function callsClaude(file: string, text: string): boolean {
  if (DEFINITIONS.has(file)) return false;
  return /\b(callTask|callClaude)\(/.test(text);
}

test('every function that can reach a plain Claude call is deferred, and only those are', () => {
  const files = sourceFiles(SRC);
  const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const graph = new Map(files.map((file) => [file, importsOf(file, texts.get(file)!)]));

  const reaches = new Map<string, boolean>();
  const visit = (file: string, path: Set<string>): boolean => {
    const known = reaches.get(file);
    if (known !== undefined) return known;
    if (path.has(file)) return false;
    path.add(file);
    const text = texts.get(file);
    const result = text !== undefined && (callsClaude(file, text) || (graph.get(file) ?? []).some((dep) => visit(dep, path)));
    path.delete(file);
    reaches.set(file, result);
    return result;
  };

  const functions = files.filter((file) => file.startsWith(join(SRC, 'functions') + '/'));
  const name = (file: string) => relative(SRC, file);
  const declares = (file: string, field: string) => new RegExp(`^\\s*${field}:`, 'm').test(texts.get(file)!);
  const reachesClaude = functions.filter((file) => visit(file, new Set())).map(name).sort();
  const covered = functions.filter((file) => declares(file, 'deferred') || declares(file, 'claudeInsideStream')).map(name).sort();

  assertEquals(
    reachesClaude.filter((file) => !covered.includes(file)),
    [],
    'these functions reach a plain Claude call outside a stream: add `deferred` (or move the call into the SSE producer and declare `claudeInsideStream`)',
  );
  assertEquals(
    covered.filter((file) => !reachesClaude.includes(file)),
    [],
    'these functions declare `deferred` or `claudeInsideStream` but never call Claude (remove the declaration)',
  );
  assertEquals(
    functions.filter((file) => declares(file, 'claudeInsideStream') && !/ctx\.sse\(/.test(texts.get(file)!)).map(name),
    [],
    'these functions declare `claudeInsideStream` but never open a stream',
  );
});
