---
"@fancysauce/sdk": minor
---

Add `fancy.recordBatchResult()`, which records one billed result of a provider batch API (for example Anthropic Message Batches) as an LLM-call span with token usage, per-result attribution, and a batch service tier. Span ids derive from the provider, batch id, and custom id, so a repeated record is deduplicated by the ingest. `recordBatchResult()` is async and returns `Promise<boolean>`. Adds `fancysauce.batch.id`, `fancysauce.batch.custom_id`, and `fancysauce.service_tier` to the wire contract (schema 1.0.1).
