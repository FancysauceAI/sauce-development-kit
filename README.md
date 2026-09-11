# Fancysauce SDK for TypeScript

Attribute your application's AI usage and cost to the customers, products, and features that drove it — in one line around the call.

Your application calls OpenAI, Anthropic, or the Vercel AI SDK. This SDK records each of those calls as an OpenTelemetry span, stamps it with the attribution you declare, and ships it to Fancysauce, where the provider's own token counts become spend broken down by whatever dimensions you named.

## Install

```bash
pnpm add @fancysauce/sdk openai @traceloop/instrumentation-openai
```

The SDK creates no spans on its own; the `@traceloop/instrumentation-*` package for each provider you use does. Install the one that matches your client:

| Provider client      | Instrumentation package                    |
| -------------------- | ------------------------------------------ |
| `openai`             | `@traceloop/instrumentation-openai`        |
| `@anthropic-ai/sdk`  | `@traceloop/instrumentation-anthropic`     |
| `ai` (Vercel AI SDK) | none — see [Vercel AI SDK](#vercel-ai-sdk) |

Both instrumentation packages are optional peer dependencies, so installing only the one you need is expected. They are imported on demand, the first time you instrument a client of that provider.

## Quickstart

```ts
import { fancy } from "@fancysauce/sdk";
import OpenAI from "openai";

// Once, at startup, before anything creates a span.
fancy.init({
  apiKey: process.env.FANCYSAUCE_API_KEY!,
  name: "support-chat",
  attribution: { environment: "prod" },
});

const openai = fancy.instrument(new OpenAI());

// Around the work you want attributed.
const reply = await fancy.attribute({ customer: "acme-42" }, () =>
  openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "Refund invoice 4412" }],
  }),
);
```

Every call made inside that closure carries `customer: acme-42` alongside the process-wide `environment: prod`, and arrives as spend you can group by either one.

Three things have to be true for a call to be attributed:

1. `fancy.init()` ran first. `fancy.instrument()` throws if it did not, because the wrap has to bind a live configuration.
2. The client went through `fancy.instrument()`. Wrapping is per instance; span creation is per class (see [How it works](#how-it-works)).
3. The call happened inside a scope — a `fancy.attribute()` closure, a `start()`ed flow, client-bound attribution, or a per-call override.

A call that misses the third still ships a span; it just carries only the `init()` defaults.

## Attribution

An attribution bag is a flat object of category keys to values: `{ customer: "acme-42", product: "support-chat", feature: "refunds" }`. You choose the keys. They become `fancysauce.attribution.<key>` on the span.

### The closure form

`attribute(scope, fn)` runs `fn` with `scope` merged over whatever is already active, and is the only form that cannot leak between concurrent flows. It returns what `fn` returns, so an async callback's scope stays open for the whole promise. The one exception is `context: "global"`, where a returned thenable is adopted into a native promise — the scope has to be restored after it settles — so what comes back is a promise rather than the thenable itself.

```ts
await fancy.attribute({ customer: "acme-42", feature: "refunds" }, async () => {
  await classify();
  await respond(); // both calls carry both keys
});
```

Scopes nest, and the inner one wins on a shared key:

```ts
await fancy.attribute({ customer: "acme-42" }, async () => {
  await fancy.attribute({ feature: "summarize" }, () => summarize()); // customer + feature
  await draft(); // customer only
});
```

### Metadata

A second argument carries metadata — free-form context you want on the span but do not want to group spend by. It lands under `fancysauce.metadata.<key>` and is never treated as a spend category.

```ts
await fancy.attribute({ customer: "acme-42" }, { metadata: { ticket: "ZD-88213" } }, () =>
  respond(),
);
```

### start / add / end

When a closure does not fit the shape of your code — a middleware that sets the scope and returns, a job runner — use the imperative form:

```ts
fancy.attribute.start({ customer: req.tenant });
fancy.attribute.add({ feature: "search" }); // merges into the active scope
fancy.attribute.end("feature"); // drops one attribution key; reserved keys and metadata cannot be removed this way
fancy.attribute.end(); // drops the whole scope
```

`start()` and `add()` both merge into whatever scope is already active; they differ only in intent, so a flow that has not started one can call either.

`start()` binds the current synchronous execution context and every continuation created from it afterwards — the function you call it in, everything it awaits later, and, if called before that function's first `await`, the caller too. `end()` follows the same rule. Call them at a request or job boundary. When several flows share a process, prefer the closure form, which cannot leak.

`start()` needs `AsyncLocalStorage.enterWith()`; on a runtime that lacks it, it throws and tells you to use the closure form or a per-call override.

### Per-call override

For a single call, put a `fancysauce` field on the request. The SDK lifts it out before the vendor sees it — the provider receives exactly the request you wrote, minus that field.

With OpenAI it rides on the request options (the second argument):

```ts
await openai.chat.completions.create({ model: "gpt-5-mini", messages }, {
  fancysauce: { feature: "refund-handling" },
} as OpenAI.RequestOptions);
```

With Anthropic it rides on the request body:

```ts
await anthropic.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 100,
  messages,
  fancysauce: { feature: "refund-handling" },
} as Anthropic.MessageCreateParamsNonStreaming);
```

Both provider SDKs type their parameters as closed objects, hence the assertions. Either carrier works for either provider; the SDK reads whichever argument carries the key, and removes it from all of them.

### Client-bound attribution

Attribution that applies to every call on one client instance belongs on `instrument()`:

```ts
const openai = fancy.instrument(new OpenAI(), { attribution: { product: "support-chat" } });
```

### Precedence

From weakest to strongest, later wins on a shared key:

1. `init({ attribution })` — process-wide defaults.
2. The active `attribute()` scope, innermost last.
3. `instrument(client, { attribution })` — the client instance's own.
4. The per-call `fancysauce` override.

### Reserved keys

Two keys are not spend categories. They identify who and what the call belongs to, and are written as standard OpenTelemetry attributes instead of `fancysauce.attribution.*`:

| Key            | Becomes                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `member`       | `user.email` when the value looks like an email address (lowercased), otherwise `user.id` |
| `conversation` | `gen_ai.conversation.id` and `session.id`                                                 |

```ts
await fancy.attribute(
  { customer: "acme-42", member: "j.park@example.com", conversation: "conv_8f31a2" },
  () => respond(),
);
```

Reserved keys are lifted only out of the attribution bag. In a `metadata` bag they stay ordinary metadata keys.

### Key and value rules

Keys are normalized before anything else: trimmed, lowercased, and then required to match `[a-z0-9_-]{1,40}`. So `{ Customer: "…" }` and `{ customer: "…" }` are the same key.

Values may be a string, number, bigint, or boolean. Strings are trimmed; everything is stringified and then cut to 200 characters.

A key is dropped, with a one-time warning naming it, when:

- the normalized key does not match the pattern (spaces, dots, non-ASCII, over 40 characters);
- the key starts with `fancysauce.`, `gen_ai.`, or `user.` — those namespaces belong to the wire contract and cannot be written from a bag;
- the value is empty, `null`, `undefined`, `NaN`, `Infinity`, or a type that is not one of the four above;
- two keys normalize to the same key in one bag;
- a reserved key's value is over 200 characters — identity keys are never truncated, because half an email address matches the wrong person.

Dropping is always reported once per distinct key. A typo is a month of missing attribution otherwise.

## Content and privacy

By default (`content: "full"`) the instrumentation records prompts and responses onto the span, under the GenAI semantic-convention attributes `gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions`.

### Turning content off

```ts
fancy.init({ apiKey, content: "none" });
```

`"none"` works at both layers: the instrumentation is told not to record content in the first place, and the exporter strips those three attributes on the way out as a backstop. Token counts, model names, latency, attribution, and everything else still ship.

The backstop is exactly those three keys and nothing else. Any other attribute carrying prompt or response text — one your own code sets, one another instrumentation writes, the ones the Vercel AI SDK records under its own names — passes through untouched, and is governed only by whatever told that layer to record it. For the AI SDK that is `recordInputs` and `recordOutputs`; see [Vercel AI SDK](#vercel-ai-sdk).

### Redacting

`redact` runs on each content attribute's serialized value, in your process, immediately before export:

```ts
fancy.init({
  apiKey,
  redact: (value) => value.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[email]"),
});
```

The value arrives already serialized — the GenAI conventions carry these as JSON strings, and that is the form exported. A second argument, omitted above, is the attribute name, so one redactor can treat inputs and outputs differently. A redactor that throws, or that returns anything other than a string, drops the attribute entirely: an unredacted prompt is never the fallback.

### What leaves the process

Spans. Each export is an OTLP/HTTP JSON request to `${endpoint}/v1/traces`, gzipped, with your API key as a bearer token. The SDK reads nothing else about your process — no environment, no configuration files, no source.

Which spans is the part worth reading twice. With `registerProvider` at its default, `init()` owns the global tracer provider, so every span created against it is exported — not only the LLM ones. A span your own code starts, or a span from any other OpenTelemetry instrumentation you have loaded, goes to Fancysauce as well, carrying whatever that instrumentation puts on it: request URLs, SQL statements, exception messages and stack traces on recorded errors. `content: "none"` and `redact` reach none of that; both act only on the three GenAI content attributes above.

If that is more than you mean to send, take the pipeline back: `init({ registerProvider: false })` and attach `fancy.spanProcessors()` to a provider you build (see [Bringing your own tracer provider](#bringing-your-own-tracer-provider)). The processors still export every span the provider they are attached to receives — but which provider that is, and which instrumentations feed it, becomes your decision rather than this SDK's.

### The size cap

Each content attribute is capped at 256 KB of UTF-8, cut on a code-point boundary. A span that had anything cut also carries `fancysauce.content.truncated = true`, so a truncated prompt is visible rather than silently short.

Any span that still carries content carries `fancysauce.content.bytes` too — the UTF-8 size of the content attributes as exported, after redaction and truncation. It is advisory: the ingest recomputes the size from what actually arrives, and reads this to notice a disagreement.

Batches are capped separately, by the ingest. When a batch comes back `413 Payload Too Large`, the exporter halves it and retries both halves, so one oversized span cannot hold back everything queued behind it.

## Configuration

`fancy.init(options)` — call it once, at startup. A second call warns and keeps the first configuration.

| Option                   | Type                                           | Default                        | What it does                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                 | `string`                                       | required                       | Your Fancysauce API key (`fs_live_…` or `fs_test_…`). Missing or empty throws; a key without an `fs_` prefix warns but still starts.                                                            |
| `name`                   | `string`                                       | unset                          | How this application appears in the dashboard. Becomes `service.name`.                                                                                                                          |
| `version`                | `string`                                       | unset                          | Application version. Becomes `service.version`.                                                                                                                                                 |
| `endpoint`               | `string`                                       | `https://ingest.fancysauce.ai` | Ingest base URL; trailing slashes are stripped. A value that is not an `http(s)` URL throws, and so does a plain `http://` one unless its host is loopback (`localhost`, `127.0.0.1`, `[::1]`). |
| `attribution`            | bag                                            | `{}`                           | Process-wide attribution defaults, stamped on every span.                                                                                                                                       |
| `content`                | `"full" \| "none"`                             | `"full"`                       | Capture prompts and responses.                                                                                                                                                                  |
| `redact`                 | `(value: string, attribute: string) => string` | unset                          | Runs on each content attribute before it leaves the process.                                                                                                                                    |
| `context`                | `"auto" \| "global"`                           | `"auto"`                       | `"auto"` isolates concurrent flows with `AsyncLocalStorage`. `"global"` is single-flow mode for scripts and batch jobs: one process-wide scope, no isolation.                                   |
| `registerProvider`       | `boolean`                                      | `true`                         | Build a tracer provider and register it globally. Set `false` to own the provider yourself — see [Bringing your own tracer provider](#bringing-your-own-tracer-provider).                       |
| `registerContextManager` | `boolean`                                      | `true`                         | Install an `AsyncLocalStorage` context manager when none is present. Set `false` when your host installs its own later in startup. Ignored when `registerProvider` is `false`.                  |
| `debug`                  | `boolean`                                      | `false`                        | Log SDK internals with `console.debug`: attribution, metadata and reserved key names, and the reason a key was dropped — never the values.                                                      |

The runtime surface is the `fancy` object:

| Member            | Signature                                                                  |
| ----------------- | -------------------------------------------------------------------------- |
| `init`            | `(options: InitOptions) => void`                                           |
| `attribute`       | `(scope, fn)` / `(scope, { metadata }, fn)`, plus `.start`, `.add`, `.end` |
| `instrument`      | `(client, options?) => client`, plus `.ready(): Promise<void>`             |
| `vercelTelemetry` | `() => VercelTelemetry`                                                    |
| `spanProcessors`  | `() => SpanProcessor[]`                                                    |
| `forceFlush`      | `() => Promise<void>`                                                      |
| `shutdown`        | `() => Promise<void>`                                                      |

Beside it the package exports `SCHEMA_VERSION` — the wire contract's version, the same constant `@fancysauce/sdk/contract` carries — and the option types the table above refers to: `InitOptions`, `AttributeOptions`, `BagInput`, `ContentMode`, `ContextMode`, `InstrumentOptions`, `VercelTelemetry`, and `Fancy`.

Two subpaths sit beside it:

- `@fancysauce/sdk/vercel` exports just `vercelTelemetry`, bound to the same process-wide SDK, for a module that wants the one helper.
- `@fancysauce/sdk/contract` is the wire contract — `SCHEMA_VERSION`, the attribute names, the reserved-key mapping, the key pattern, and the limits. It has no runtime dependencies, so a consumer on the other side of the wire can pin it directly.

### Bringing your own tracer provider

If your application owns its own OpenTelemetry tracer provider, tell `init()` not to build one. It still resolves your configuration and builds the span processors — stamping, plus batching and export — and `spanProcessors()` hands them over for your provider's constructor:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

fancy.init({ apiKey: process.env.FANCYSAUCE_API_KEY!, registerProvider: false });

const provider = new NodeTracerProvider({
  resource: myResource,
  spanProcessors: [...myProcessors, ...fancy.spanProcessors()],
});
provider.register();
```

The constructor is the only seam — an OpenTelemetry SDK 2.x provider accepts processors there and nowhere else — which is why `init()` runs first and your provider is built from what it returns. `register()` is yours to call, and it installs the context manager, so `registerContextManager` does nothing in this mode.

The processors are all you get: the resource is yours to set. `service.name`, `service.version`, `fancysauce.schema_version`, `fancysauce.sdk.version`, and the `init({ attribution })` copy live on the resource `init()` builds for its own provider, so none of them ship unless you put them on yours. Every span still carries the attribution itself, which the stamping processor writes.

`fancy.instrument()` works unchanged: it patches the client's class against whatever provider is globally registered, which is now yours. `forceFlush()` and `shutdown()` drive the SDK's own processors and leave your provider alone.

Leaving `registerProvider` at its default while a provider is already registered is not a way to do this, and `init()` warns about it: the provider it built never becomes global, so no span reaches the stamping processor or the exporter.

## Vercel AI SDK

The AI SDK creates its own spans, so there is nothing to `instrument()`. Pass `fancy.vercelTelemetry()` as the call's telemetry option; it carries the content policy `init()` resolved, and its tracer resolves against the provider `init()` registered.

```ts
import { fancy } from "@fancysauce/sdk";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

fancy.init({ apiKey: process.env.FANCYSAUCE_API_KEY!, name: "support-chat" });

const { text } = await fancy.attribute({ customer: "acme-42" }, () =>
  generateText({
    model: openai("gpt-5-mini"),
    prompt: "Refund invoice 4412",
    // AI SDK 4 and 5: experimental_telemetry. AI SDK 7: telemetry.
    experimental_telemetry: { ...fancy.vercelTelemetry(), functionId: "refunds" },
  }),
);
```

- AI SDK **4 and 5** read the option as `experimental_telemetry` and use the `tracer` it carries.
- AI SDK **7** reads it as `telemetry` and ignores `tracer`, using the globally registered tracer provider instead — so `fancy.init()` must run at startup either way.

Spread the object to add the AI SDK's own fields, as above; `functionId` and its `metadata` are the AI SDK's, not this SDK's.

The object carries `recordInputs` and `recordOutputs`, set from `init({ content })`, and those are the only thing governing the content the AI SDK records — it writes its prompts and responses under its own attribute names, which the exporter's three-key backstop does not cover. So pass this object through rather than hand-writing `isEnabled: true`: content you turned off at `init()` would otherwise ship anyway.

Build it after `init()`. Called before, it warns and returns a policy that records content, and keeps recording it even if a later `init({ content: "none" })` turns that off — the policy is frozen into the object so that spreading it stays safe.

## Serverless

A serverless function can be frozen or torn down the moment its handler returns, taking the export queue with it. Flush before you return:

```ts
export async function handler(event) {
  const result = await fancy.attribute({ customer: event.tenant }, () => respond(event));
  await fancy.forceFlush();
  return result;
}
```

`forceFlush()` leaves the SDK usable, which is what you want when the runtime reuses the instance for the next invocation. `shutdown()` is the end-of-process call: it flushes, shuts the exporter down, and releases the global tracer provider and the context manager — each only if `init()` was the one that claimed it.

Run `init()` at module scope, not inside the handler — a second `init()` is a no-op that warns, and instrumenting on every invocation wastes the work.

## How it works

The SDK is a thin, opinionated OpenTelemetry setup. Nothing here is a private protocol.

**`init()`** resolves your configuration and builds two span processors. Unless you passed `registerProvider: false`, it wraps them in a `NodeTracerProvider` and registers that as the global tracer provider, and installs an `AsyncLocalStorage` context manager if none is present — without one, nothing nests and every span is a root span. Your process-wide attribution goes onto the OpenTelemetry resource, where it is written once per export rather than once per span. The precedence above is about span attributes; the resource copy is the configuration as `init()` resolved it, and a scope that overrides one of those keys does not change it.

**`instrument(client)`** does two separate things. It patches the client's _class_ through the OpenLLMetry instrumentation package for that provider, which is what creates the spans — and because prototypes are shared, that turns on span creation for every client of that class in the process, including ones you never passed in. And it wraps the _instance's_ known methods so each call runs inside its attribution scope. Only instrumented instances carry client-bound attribution; spans from the others get the ambient scope and the `init()` defaults. Content capture rides that shared prototype too: under the default `content: "full"`, a client you never passed to `instrument()` records its prompts and responses onto its spans, and they are exported like any other.

The class patch loads its instrumentation package on demand, so it is asynchronous. A call made before it lands carries attribution but produces no span, which is why `instrument()` belongs in startup. `await fancy.instrument.ready()` turns that convention into a guarantee, for a test or a short script that cannot rely on startup ordering.

**The stamping processor** copies the active attribution scope onto every span at start — `onStart`, on a live span, which is the contract-blessed place to set attributes. Stamping at start also puts attribution ahead of the 128-attribute cap that per-message instrumentation attributes can hit, so attribution is never what gets dropped. For the reserved identity attributes only, a value the instrumentation already set wins: an explicit conversation id on the span is more specific than the ambient one.

**The exporter** is OTLP/HTTP JSON to `${endpoint}/v1/traces`, gzipped, with bearer auth, behind a `BatchSpanProcessor` holding at most 512 spans and exporting at most 64 at a time. It retries `429`, `502`, `503`, and `504` with backoff and honors `Retry-After`. A decorator around it enforces the content policy — strip, redact, cap at 256 KB — and implements the `413` halving described above.

`fancysauce.schema_version` and `fancysauce.sdk.version` are resource attributes, not span attributes — they sit alongside `service.name`, `service.version`, and the `init({ attribution })` copy on the resource shared by every span in an export, so the ingest can read a span emitted by an older SDK without guessing.

## Supported

Status: early access.

|                      |                       |
| -------------------- | --------------------- |
| Node.js              | ≥ 22.11 (required)    |
| `openai`             | tested with `^7.15`   |
| `@anthropic-ai/sdk`  | tested with `^0.125`  |
| `ai` (Vercel AI SDK) | tested with 7 (types) |
| Module formats       | ESM and CommonJS      |

The Node floor is a hard requirement. The client rows are the versions this repository's suite runs against, not a claim about the range that works: the `openai` and `@anthropic-ai/sdk` clients are driven end to end against a fake provider, while `ai` is imported for its types alone, so the telemetry option is checked at build time rather than called.

Instrumented methods:

| Client    | Methods                                                            |
| --------- | ------------------------------------------------------------------ |
| OpenAI    | `chat.completions.create`, `responses.create`, `embeddings.create` |
| Anthropic | `messages.create`, `messages.stream`                               |

`embeddings.create` is wrapped for attribution but is not spanned by the OpenAI instrumentation; it carries attribution onto any span your own code creates around it. `messages.stream` is wrapped for the same reason — it reaches `messages.create` internally, and wrapping it is what keeps that inner call inside your scope.

The provider is detected from the client's own surface rather than from its package, so a subclass, a proxy, or a client built by a wrapper library is recognized the same way.

A client that is neither — no `chat.completions.create`, no `responses.create`, no `messages.create` — makes `instrument()` throw rather than hand the client back unwrapped, naming the supported set: an OpenAI client, an Anthropic client, and `fancy.vercelTelemetry()` for the Vercel AI SDK. Silently returning it would look identical to success and produce no attribution at all.

Runtime notes:

- `fancy.attribute.start()` needs `AsyncLocalStorage.enterWith()`. The closure form and per-call overrides work without it.
- On a runtime where `AsyncLocalStorage` is unavailable or undesirable, `context: "global"` gives one process-wide scope with no async isolation — correct for scripts and batch jobs, not for a server handling concurrent requests.

## Examples

[`examples/node-openai`](examples/node-openai) is a runnable, end-to-end script: init, instrument, attribute, flush. Set `FANCYSAUCE_API_KEY` and `OPENAI_API_KEY`, then:

```bash
pnpm --filter examples-node-openai start
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [Apache-2.0](LICENSE).
