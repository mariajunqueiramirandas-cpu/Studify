# 0006 — Retrieval without embeddings (knowledge-map routing + Postgres FTS)

| Status | Accepted |
|---|---|
| Date | 2026-10-26 |
| Related | [Architecture §4.3](../architecture.md#43-tutor-chat-tut-01) · [AI pipeline](../ai-pipeline.md) · [03 — Tutor](../../specs/03-tutor.md) |

## Context

The tutor (TUT-01…05), "Explica de outro jeito" (LRN-03) and Câmera Mágica (CAM-01/02) all need to pick **which pages** of a subject's material to send to Claude for a given question.

- A subject can hold hundreds of pages. Sending everything every turn is expensive even with caching, and it dilutes attention.
- Two strong signals already exist without embeddings:
  1. The **knowledge map**: every topic and concept has page ranges (`node_sources`), titles, summaries and key terms.
  2. The **page text layer**, extracted at ingestion into `document_pages` with a `tsvector`.
- Anthropic doesn't offer an embeddings API, so embeddings would add a second AI vendor (cost, privacy disclosure, another DPA).
- Most content is Portuguese. Postgres has a `portuguese` text-search configuration (stemming, stop words).

## Decision

Retrieval v1 uses **no embeddings**:

1. **Scope first.** Candidate pages are limited to what the caller may read (RLS / `can_read_subject`) and to the requested scope (subject, goal/exam scope, topic, or highlighted passage).
2. **Topic routing.** Score the knowledge-map nodes in scope against the question:
   - Postgres FTS (`websearch_to_tsquery('portuguese', …)`) over node title, summary and key terms.
   - Plus the current context: the topic the user is viewing, and the item they came from (card, question, citation).
3. **Page search.** FTS over `document_pages.tsv` within the scope, ranked with `ts_rank_cd`, with the `unaccent` extension for accent-insensitive matching.
4. **Merge** the page ranges of the top nodes with the top FTS pages. Expand each by ±1 page for context. Cap the total by a token budget (e.g. ≤ 40 pages per tutor turn, tuned by evals).
5. **Fallback.** If routing and FTS return nothing confident, and the question is short or vague, pass the scope's **outline** (titles + summaries) instead of pages. The model can then ask a clarifying question or answer "não está no seu material" (TUT-04).
6. Retrieved page ranges are sent as **PDF slices** with citations enabled, and cached for follow-up turns in the same thread.

**Revisit trigger:** add embeddings (pgvector) **only if** the tutor eval shows retrieval misses. That is, a page containing the answer is not among the retrieved pages in > 10% of the in-material eval questions, or paraphrase-heavy questions fail where FTS can't match terms.

## Alternatives considered

| Option | Why not (for now) |
|---|---|
| **pgvector + embeddings (e.g. Voyage)** | Adds a vendor, cost and a data-sharing disclosure. Needs chunking and an embedding refresh pipeline. The benefit is unproven while the knowledge map already provides semantic structure. |
| **Send the whole subject each turn** | Simple, but cost grows with subject size, and long contexts dilute focus. Fine as a strategy for very small subjects (< ~30 pages, threshold tuned in evals). |
| **Ask Claude to pick topics first (two-step routing)** | Better recall on vague questions, but doubles latency and cost per turn. Kept as an option for the fallback path if evals show benefit. |

## Consequences

- **+** No extra vendor. Everything runs in Postgres with existing data. Retrieval is cheap and fast.
- **+** The knowledge map gets a second job (routing), which rewards keeping it accurate (ING-04 edits improve retrieval).
- **−** Pure keyword search can miss paraphrases ("fotossíntese" vs "como as plantas produzem alimento"). Mitigated by node summaries and key terms written by the model at ingestion, by passing the outline as fallback, and by evals with paraphrased questions.
- **−** Scanned pages have a weak text layer. Mitigation: at ingestion, the worker stores a **model-produced page transcription** for pages without a usable text layer (see [ai-pipeline.md](../ai-pipeline.md)), so FTS still works.
