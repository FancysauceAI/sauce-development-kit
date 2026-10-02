/**
 * One OpenAI call, attributed end to end.
 *
 *   FANCYSAUCE_API_KEY=fs_test_… OPENAI_API_KEY=sk-… pnpm start [customer]
 *
 * Nothing here is example-only: this is the whole shape of using the SDK from a
 * script — init once, instrument the client, attribute the work, flush before
 * the process exits.
 */
import { fancy } from "@fancysauce/sdk";
import OpenAI from "openai";

fancy.init({
  apiKey: process.env.FANCYSAUCE_API_KEY!,
  name: "example-node-openai",
  attribution: { environment: "dev" },
});
const openai = fancy.instrument(new OpenAI());

// A long-lived service instruments at startup and never needs this. A script
// makes its first call immediately, so it waits for the class patch — which
// loads the instrumentation package on demand — to land, because a call made
// before it does carries attribution but produces no span.
await fancy.instrument.ready();

const reply = await fancy.attribute(
  { customer: process.argv[2] ?? "acme-42", conversation: `conv_${Date.now()}` },
  () =>
    openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "Say hi in five words." }],
    }),
);
console.log(reply.choices[0]?.message.content);

// Flushes the export queue and releases the tracer provider; without it the
// process can exit with the span still queued.
await fancy.shutdown();
