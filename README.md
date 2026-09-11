# Fancysauce SDK for TypeScript

Attribute your application's AI usage and cost to the customers, products, and features that drove it — in one line around the call.

```ts
import { fancy } from "@fancysauce/sdk";
import OpenAI from "openai";

fancy.init({ apiKey: process.env.FANCYSAUCE_API_KEY!, name: "support-chat" });
const openai = fancy.instrument(new OpenAI());

await fancy.attribute({ customer: "acme-42" }, async () => {
  await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hi" }],
  });
});
```

Status: early access. Supported: Node ≥ 22.11, OpenAI SDK ≥ 4.12, Anthropic SDK ≥ 0.30, Vercel AI SDK ≥ 4.

- [Install](#install) · [Quickstart](#quickstart) · [Attribution](#attribution) · [Content and privacy](#content-and-privacy) · [Configuration](#configuration) · [How it works](#how-it-works)
