# @fancysauce/sdk

## 0.2.0

### Minor Changes

- 9825d7f: Add `fancy.recordBatchResult()`, which records one billed result of a provider batch API (for example Anthropic Message Batches) as an LLM-call span with token usage, per-result attribution, and a batch service tier. Span ids derive from the provider, batch id, and custom id, so a repeated record is deduplicated by the ingest. `recordBatchResult()` is async and returns `Promise<boolean>`. Adds `fancysauce.batch.id`, `fancysauce.batch.custom_id`, and `fancysauce.service_tier` to the wire contract (schema 1.0.1).

## 0.1.0

### Minor Changes

- 84399d7: First release: `fancy.init()`, the attribution bag (`fancy.attribute` in closure and `start`/`add`/`end` forms, per-call overrides, `metadata`) with keys normalized to `[a-z0-9-]{1,40}` registry slugs — underscores become hyphens alongside lowercasing — and every rejected key warned about once, the content policy (`content: "full" | "none"`, `redact`, the 256 KB cap, 413 halving), the OTLP/HTTP exporter, `fancy.instrument()` for OpenAI and Anthropic clients, `fancy.vercelTelemetry()`, the `contract` and `vercel` subpaths, and a scope filter that exports the spans of instrumented AI clients and the Vercel AI SDK while dropping every other span on the provider, once with a warning. `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` are required peer dependencies.
