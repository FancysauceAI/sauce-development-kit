# @fancysauce/sdk

Attribute your application's AI usage and cost to the customers, products, and features that drove it — in one line around the call. This package is the whole SDK; the [repository README](https://github.com/FancysauceAI/sauce-development-kit#readme) is the documentation, covering installation, a quickstart, the attribution API, the content and privacy controls, every `init()` option, the Vercel AI SDK helper, serverless flushing, and the current support matrix.

```ts
import { fancy } from "@fancysauce/sdk";
import OpenAI from "openai";

fancy.init({ apiKey: process.env.FANCYSAUCE_API_KEY!, name: "support-chat" });
const openai = fancy.instrument(new OpenAI());

await fancy.attribute({ customer: "acme-42" }, () =>
  openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hi" }],
  }),
);
```
