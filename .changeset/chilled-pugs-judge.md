---
"@fancysauce/sdk": patch
---

A contract test pins `messages.parse()` coverage on instrumented Anthropic clients, so a vendor SDK release that stops routing `parse()` through `messages.create()` fails the suite instead of silently dropping the span.
