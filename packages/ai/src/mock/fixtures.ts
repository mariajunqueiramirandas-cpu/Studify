// Fixture files for the mock server. Node only (reads the directory). Used by mock/server.ts.
//
// A fixture file is JSON: one fixture or an array of fixtures, each shaped as
//   { "match": { "contains": "...", "customId": "...", "path": "/v1/messages" }, "respond": MockResponse, "once": false }
// `match` is optional (no match block = matches everything). `contains` is a substring of the
// request body text. `once: true` consumes the fixture after its first match (scripted 429 then 200).
// Fixtures are tried in file-name order, then in order within a file.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MockResponse } from "./messages.ts";

export interface MockFixture {
  match?: { contains?: string; customId?: string; path?: string };
  respond: MockResponse;
  once?: boolean;
}

export function loadFixtures(dir: string): MockFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: MockFixture[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      if (!item || typeof item !== "object" || !("respond" in item)) {
        throw new Error(`fixture ${file} has an entry without "respond"`);
      }
      out.push(item as MockFixture);
    }
  }
  return out;
}

export interface FixtureRequest {
  path: string;
  bodyText: string;
  customId?: string;
}

export function fixtureMatches(fixture: MockFixture, req: FixtureRequest): boolean {
  const m = fixture.match;
  if (!m) return true;
  if (m.path !== undefined && m.path !== req.path) return false;
  if (m.customId !== undefined && m.customId !== req.customId) return false;
  if (m.contains !== undefined && !req.bodyText.includes(m.contains)) return false;
  return true;
}
