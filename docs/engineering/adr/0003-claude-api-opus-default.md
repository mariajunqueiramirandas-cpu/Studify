# 0003 — Claude API as the only LLM, Haiku 5.5 by default

| Status | Accepted, amended 2026-10-27 (default model, effort and refusal fallback; see Amendment) |
|---|---|
| Date | 2026-10-26 (amended 2026-10-27) |
| Related | [AI pipeline](../ai-pipeline.md) · [Architecture](../architecture.md) · [Security & privacy](../security-privacy.md) · [Testing strategy](../testing-strategy.md) |

## Amendment — 2026-10-27 (owner decision)

The product owner decided the following on 2026-10-27. This amendment supersedes points 2, 5 and 7 of the Decision below for every task. The rest of the Decision stands.

1. **Default model: `claude-haiku-5-5` for every task** (the model id has no date suffix). It replaces `claude-opus-5-5`. The rule is unchanged: engineering does not change a task's model on its own. A per-task override needs an owner decision and eval evidence.
2. **Effort `high` for every task.** The per-task effort values in point 5 are retired. Prompt definitions keep an effort field as a documented hint; the request does not send it. A per-task override needs an owner decision and eval evidence.
3. **No server-side refusal fallback on Haiku 5.5.** `fallbacks` and the `server-side-fallback-2026-07-01` beta are not sent to it, because a `fallbacks` list returns 400. A refusal arrives as HTTP 200 with `stop_reason: "refusal"` and `stop_details.category` (`cyber`, `bio`, `frontier_llm` or `general_harms`). The wrapper maps it to the existing refusal outcome (`ai_refused`). Synchronous calls to models that have a fallback keep it; Batch requests never carry it.
4. **Pricing:** Haiku 5.5 has two rate cards chosen by prompt length: up to 100,000 tokens ($0.10 input, $0.50 output per MTok) and above that ($0.50 and $2.50). See [ai-pipeline §9.3](../ai-pipeline.md#93-cost-formula).

What still applies to every model: no sampling parameters, no `budget_tokens`, no assistant prefill, no forced `tool_choice`, and the Batch API rules.

## Context

Almost every feature is LLM work over the student's material:
- Build a knowledge map from PDFs (including diagrams, tables and scanned pages).
- Generate notes, cards and questions.
- Grade free-text answers and essays.
- Run a grounded tutor that cites pages.

Trust (PRD principle 3, TRU-01) depends on reliable page citations. The owner wants the best possible quality. Cost matters, but the owner decides any quality/cost trade-off.

## Decision

1. **Claude (Anthropic API) is the only LLM provider**, called through the official `@anthropic-ai/sdk` from Edge Functions and the worker only. The key never ships in the app.
2. **Default model: `claude-opus-5-5` for every task.** *(Superseded 2026-10-27: `claude-haiku-5-5`, see Amendment.)* A cheaper model (e.g. for bulk generation) is used **only if the owner explicitly decides** after seeing eval results and costs. The engineering team does not downgrade on its own.
3. **Native PDF input.** PDFs, or page-range slices of them, are sent as `document` blocks, so the model sees text **and** visuals. API limits: 32 MB per request and up to 600 pages on 1M-context models. Larger documents are sliced by page range (slices also keep each request focused).
4. **Two output modes, because citations and structured outputs can't be combined in one request** (the API returns 400):
   - **Citations mode** (`citations: {enabled: true}` on document blocks): for prose that must cite exact pages, such as tutor answers, notes and explanations. Citation `page_location` values are mapped from slice pages back to original page numbers.
   - **Structured-output mode** (`output_config.format` with JSON schemas, validated again with Zod): for the knowledge map, cards, questions and grades. These include a `source_pages` field, checked server-side to fall inside the slice's page range.
5. **Thinking and effort:** *(Effort: superseded 2026-10-27, every task runs at `high`; see Amendment.)* adaptive thinking (it can't be disabled on Opus 5.5). **Effort set explicitly per task**, because the Opus 5.5 default is `medium`: `low`/`medium` for the knowledge map (the outline must appear in under 2 minutes; raised only if outline evals fail), `high` for grading and Prova Provável, `medium` for generation and tutor, `low` for moderation and classification. Per-task levels are listed in [ai-pipeline.md §3](../ai-pipeline.md#3-task-catalog) and tuned by evals.
6. **Cost controls:**
   - **Prompt caching** of document blocks and stable system prompts, since every generation for a subject re-reads the same slices.
   - **Message Batches API** (50% price) for non-urgent bulk generation after the outline.
   - **Files API** to upload each PDF slice once and reference it across requests. Because Files API objects persist until deleted (beyond the API's default 30-day retention), file ids are ephemeral: deleted when the uploading job finishes, swept after 48 h at most, and deleted immediately with the document. Synchronous calls send slices as base64 instead ([ai-pipeline.md §4.2](../ai-pipeline.md#42-files-api)).
   - Per-user, per-Turma and global budgets (PLT-04).
7. **Refusals:** *(Fallback: superseded for Haiku 5.5 on 2026-10-27; see Amendment.)*
   - Every **synchronous** request to a model that has one uses the **server-side fallback**: beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`, which routes refusals by category. Batch requests don't accept `fallbacks`; refused batch results are re-run on the standard API ([ai-pipeline.md §7.4](../ai-pipeline.md#74-why-no-fallbacks-in-batch)).
   - Code always checks `stop_reason` (including `"refusal"`) before reading content.
   - The user sees a friendly PT-BR message when a refusal stands.
8. **Streaming** for long outputs and the tutor. SDK helpers (`finalMessage()`) for complete results.

## Alternatives considered

| Option | Why not |
|---|---|
| **Multiple providers / router** | More prompts to maintain and eval. Loses native PDF + citations as a consistent feature. Caches are per model and provider. |
| **Cheaper model by default for bulk generation** | Possible later, but it's the owner's decision, made with eval evidence (quality vs cost scorecards). |
| **Extract text ourselves and send plain text** | Loses diagrams, charts and scanned pages, and needs a separate OCR stack. Page citations would rely on our own chunk mapping. |
| **Structured outputs everywhere, with page numbers chosen by the model** | Less trustworthy than API citations for prose. Kept only for structured items, with server-side range checks. |

## Consequences

- **+** One provider and one set of prompts/evals. Best available quality. API-verified page citations for prose.
- **+** Caching + batch keep the per-page cost down. Shared Turma content is generated once.
- **−** Opus-tier pricing made cost tracking essential. Haiku 5.5 is cheaper, but it still gets `ai_usage` rows and budgets, and its two rate cards are priced by prompt length. `ai_usage` records every call, and Phase 0 measures cost per page.
- **−** The citations/structured-output split must be designed per feature (see [ai-pipeline.md](../ai-pipeline.md)).
- **−** Opus 5.5 and Haiku 5.5 behavior constraints apply: no assistant prefill, no forced `tool_choice` (`any`/`tool` → 400), no sampling parameters, thinking always on. Prompts and code must respect them.
- **−** Batch results can take time (asynchronous). The UX shows the outline first and fills in content progressively.
- **−** Students' material is processed by Anthropic in the US. This is disclosed in the privacy notice, and the transfer mechanism is a legal-review item ([security-privacy.md](../security-privacy.md), SP-16). Anthropic doesn't train on API customer content and deletes API inputs/outputs within 30 days by default (as of 2026-10-26).
