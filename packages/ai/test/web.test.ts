import { describe, expect, it } from "vitest";
import { isAllowedDomain, isCitedUrl, normalizeUrl, webSourcesOf } from "../src/web.ts";
import type { BetaContentBlock } from "../src/types.ts";

const content = [
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "seca amazônia" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "s1",
    content: [
      { type: "web_search_result", url: "https://agenciabrasil.ebc.com.br/a", title: "A", encrypted_content: "x", page_age: null },
      { type: "web_search_result", url: "https://ibge.gov.br/b", title: "B", encrypted_content: "y", page_age: null },
    ],
  },
  {
    type: "text",
    text: "Rios em níveis mínimos.",
    citations: [
      { type: "web_search_result_location", url: "https://agenciabrasil.ebc.com.br/a", title: "A", cited_text: "Rios…", encrypted_index: "e" },
      { type: "web_search_result_location", url: "https://agenciabrasil.ebc.com.br/a", title: "A", cited_text: "Rios…", encrypted_index: "e" },
    ],
  },
  { type: "text", text: " Sem citação.", citations: null },
] as unknown as BetaContentBlock[];

describe("web sources", () => {
  it("lists cited URLs once, and search results on request", () => {
    expect(webSourcesOf(content)).toEqual([{ url: "https://agenciabrasil.ebc.com.br/a", title: "A", citedText: "Rios…" }]);
    expect(webSourcesOf(content, { includeResults: true }).map((s) => s.url)).toEqual(["https://agenciabrasil.ebc.com.br/a", "https://ibge.gov.br/b"]);
  });

  it("ignores an error result block", () => {
    const err = [{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }] as unknown as BetaContentBlock[];
    expect(webSourcesOf(err, { includeResults: true })).toEqual([]);
  });

  it("compares URLs after normalization and checks the allowlist by host", () => {
    expect(normalizeUrl("https://IBGE.gov.br/x/#top")).toBe("https://ibge.gov.br/x");
    expect(isCitedUrl("https://AgenciaBrasil.ebc.com.br/a/", [{ url: "https://agenciabrasil.ebc.com.br/a" }])).toBe(true);
    expect(isCitedUrl("https://outro.com/a", [{ url: "https://agenciabrasil.ebc.com.br/a" }])).toBe(false);
    expect(isAllowedDomain("https://www.ibge.gov.br/x", ["ibge.gov.br"])).toBe(true);
    expect(isAllowedDomain("https://ibge.gov.br.evil.com/x", ["ibge.gov.br"])).toBe(false);
    expect(isAllowedDomain("not a url", ["ibge.gov.br"])).toBe(false);
  });
});
