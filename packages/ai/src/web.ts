// Web sources of a web_search call (ai-pipeline §12, spec 09 §7.7–7.8). Research calls return prose whose text
// blocks carry `web_search_result_location` citations; the structuring call may only use these URLs.
import type { BetaContentBlock } from "./types.ts";

export interface WebSource {
  url: string;
  title: string | null;
  /** Text the model cited from the page; null for a result that was found but not cited. */
  citedText: string | null;
}

/**
 * Cited web sources of a response, first citation first, one entry per URL. With `includeResults`, URLs that
 * appeared in search results without being cited are appended (citedText null).
 */
export function webSourcesOf(content: readonly BetaContentBlock[], opts: { includeResults?: boolean } = {}): WebSource[] {
  const out = new Map<string, WebSource>();
  for (const block of content) {
    if (block.type !== "text") continue;
    for (const c of (block as { citations?: unknown[] | null }).citations ?? []) {
      const cit = c as { type?: string; url?: string; title?: string | null; cited_text?: string };
      if (cit.type !== "web_search_result_location" || !cit.url || out.has(cit.url)) continue;
      out.set(cit.url, { url: cit.url, title: cit.title ?? null, citedText: cit.cited_text ?? null });
    }
  }
  if (opts.includeResults) {
    for (const block of content) {
      if (block.type !== "web_search_tool_result") continue;
      const results = (block as { content?: unknown }).content;
      if (!Array.isArray(results)) continue; // an error result (HTTP 200 with an error code)
      for (const r of results as Array<{ type?: string; url?: string; title?: string }>) {
        if (r.type === "web_search_result" && r.url && !out.has(r.url)) out.set(r.url, { url: r.url, title: r.title ?? null, citedText: null });
      }
    }
  }
  return [...out.values()];
}

/** Normalizes a URL for comparison (lowercase host, no fragment, no trailing slash). */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

/** True when `url` is one of the cited sources (normalized comparison). */
export function isCitedUrl(url: string, sources: readonly { url: string }[]): boolean {
  const n = normalizeUrl(url);
  return sources.some((s) => normalizeUrl(s.url) === n);
}

/** Host of a URL is on the allowlist (exact host or a subdomain of it). */
export function isAllowedDomain(url: string, allowedDomains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}
