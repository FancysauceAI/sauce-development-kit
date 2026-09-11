---
"@fancysauce/sdk": minor
---

First release: `fancy.init()`, the attribution bag (`fancy.attribute` in closure and `start`/`add`/`end` forms, per-call overrides, `metadata`), the content policy (`content: "full" | "none"`, `redact`, the 256 KB cap, 413 halving), the OTLP/HTTP exporter, `fancy.instrument()` for OpenAI and Anthropic clients, `fancy.vercelTelemetry()`, the `contract` and `vercel` subpaths, and a scope filter that exports the spans of instrumented AI clients and the Vercel AI SDK while dropping every other span on the provider, once with a warning. `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` are required peer dependencies.
