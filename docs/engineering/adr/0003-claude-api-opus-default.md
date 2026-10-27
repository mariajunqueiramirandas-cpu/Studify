# 0003 — Claude API as the only LLM, Opus 5.5 by default

| Status | Accepted |
|---|---|
| Date | 2026-10-26 |
| Related | [AI pipeline](../ai-pipeline.md) · [Architecture](../architecture.md) · [Security & privacy](../security-privacy.md) · [Testing strategy](../testing-strategy.md) |

## Context

Almost every feature is LLM work over the student's material:
- Build a knowledge map from PDFs (including diagrams, tables and scanned pages).
- Generate notes, cards and questions.
- Grade free-text answers and essays.
- Run a grounded tutor that cites pages.

Trust (PRD principle 3, TRU-01) depends on reliable page citations. The owner wants the best possible quality. Cost matters, but the owner decides any quality/cost trade-off.

## Decision

1. **Claude (Anthropic API) is the only LLM provider**, called through the official `@anthropic-ai/sdk` from Edge Functions and the worker only. The key never ships in the app.
2. **Default model: `claude-opus-5-5` for every task.** A cheaper model (e.g. for bulk generation) is used **only if the owner explicitly decides** after seeing eval results and costs. The engineering team does not downgrade on its own.
3. **Native PDF input.** PDFs, or page-range slices of them, are sent as `document` blocks, so the model sees text **and** visuals. API limits: 32 MB per request and up to 600 pages on 1M-context models. Larger documents are sliced by page range (slices also keep each request focused).
4. **Two output modes, because citations and structured outputs can't be combined in one request** (the API returns 400):
   - **Citations mode** (`citations: {enabled: true}` on document blocks): for prose that must cite exact pages, such as tutor answers, notes and explanations. Citation `page_location` values are mapped from slice pages back to original page numbers.
   - **Structured-output mode** (`output_config.format` with JSON schemas, validated again with Zod): for the knowledge map, cards, questions and grades. These include a `source_pages` field, checked server-side to fall inside the slice's page range.
5. **Thinking and effort:** adaptive thinking (it can't be disabled on Opus 5.5). **Effort set explicitly per task**, because the Opus 5.5 default is `medium`: `low`/`medium` for the knowledge map (the outline must appear in under 2 minutes; raised only if outline evals fail), `high` for grading and Prova Provável, `medium` for generation and tutor, `low` for moderation and classification. Per-task levels are listed in [ai-pipeline.md §3](../ai-pipeline.md#3-task-catalog) and tuned by evals.
6. **Cost controls:**
   - **Prompt caching** of document blocks and stable system prompts, since every generation for a subject re-reads the same slices.
   - **Message Batches API** (50% price) for non-urgent bulk generation after the outline.
   - **Files API** to upload each PDF slice once and reference it across requests. Because Files API objects persist until deleted (beyond the API's default 30-day retention), file ids are ephemeral: deleted when the uploading job finishes, swept after 48 h at most, and deleted immediately with the document. Synchronous calls send slices as base64 instead ([ai-pipeline.md §4.2](../ai-pipeline.md#42-files-api)).
   - Per-user, per-Turma and global budgets (PLT-04).
7. **Refusals:**
   - Every **synchronous** request uses the **server-side fallback**: beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`, which routes refusals by category. Batch requests don't accept `fallbacks`; refused batch results are re-run on the standard API ([ai-pipeline.md §7.4](../ai-pipeline.md#74-why-no-fallbacks-in-batch)).
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
- **−** Opus-tier pricing makes cost tracking essential. `ai_usage` records every call, and Phase 0 measures cost per page.
- **−** The citations/structured-output split must be designed per feature (see [ai-pipeline.md](../ai-pipeline.md)).
- **−** Opus 5.5 behavior constraints apply: no assistant prefill, no forced `tool_choice` (`any`/`tool` → 400), no sampling parameters, thinking always on. Prompts and code must respect them.
- **−** Batch results can take time (asynchronous). The UX shows the outline first and fills in content progressively.
- **−** Students' material is processed by Anthropic in the US. This is disclosed in the privacy notice, and the transfer mechanism is a legal-review item ([security-privacy.md](../security-privacy.md), SP-16). Anthropic doesn't train on API customer content and deletes API inputs/outputs within 30 days by default (as of 2026-10-26).
