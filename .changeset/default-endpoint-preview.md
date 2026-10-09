---
"@fancysauce/sdk": patch
---

Point the default `endpoint` at `https://ingest.preview.fancysauce.ai`, the live ingest host. The old default, `https://ingest.fancysauce.ai`, has no DNS record, so `fancy.init()` without an `endpoint` exported no spans.
