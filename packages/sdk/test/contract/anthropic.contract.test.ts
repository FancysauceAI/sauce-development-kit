/**
 * The Anthropic half of the wire contract: a real `@anthropic-ai/sdk` client, a
 * fake Anthropic server, and a fake collector, so what is asserted is the
 * OTLP/HTTP JSON the SDK actually posts rather than an in-memory span.
 * `out/anthropic-messages.otlp.json` is the recorded shape, which the ingest
 * vendors as a fixture and `recordOrCompare` holds this suite to.
 */
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fancy } from "../../src/index.js";
import { ANTHROPIC_STRUCTURED_OUTPUT, startFakeAnthropic } from "./fake-anthropic.js";
import { attr, contentBytes, startReceiver, type OtlpExportRequest } from "./otlp-receiver.js";
import { recordOrCompare } from "./recording.js";

const OUT = join(import.meta.dirname, "out");

describe("Anthropic end to end", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let provider: Awaited<ReturnType<typeof startFakeAnthropic>>;

  beforeAll(async () => {
    receiver = await startReceiver();
    provider = await startFakeAnthropic();
    fancy.init({
      apiKey: "fs_test_contract",
      name: "contract-app",
      version: "0.0.1",
      endpoint: receiver.url,
      attribution: { environment: "test" },
    });
  });

  afterAll(async () => {
    // shutdown() releases the global tracer provider and the context manager
    // this init() claimed.
    await fancy.shutdown();
    await provider.close();
    await receiver.close();
  });

  it("ships a messages span with usage, attribution, content, and the resource contract", async () => {
    const anthropic = fancy.instrument(
      new Anthropic({ apiKey: "sk-ant-test", baseURL: provider.baseURL }),
      { attribution: { product: "support-chat" } },
    );
    // The class patch loads its instrumentation package on demand, so a call
    // made before it lands carries attribution but produces no span.
    await fancy.instrument.ready();
    await fancy.attribute(
      { customer: "acme-42", conversation: "conv_8f31a2", member: "j.park@example.com" },
      { metadata: { ticket: "ZD-88213" } },
      async () => {
        await anthropic.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 100,
          system: "You are support.",
          messages: [{ role: "user", content: "Refund invoice 4412" }],
          // The override rides on the request body here and on the request
          // options in the OpenAI suite, so both carriers are covered. The
          // provider SDKs' parameter types are closed, hence the assertion.
          fancysauce: { feature: "refund-handling" },
        } as Anthropic.MessageCreateParamsNonStreaming);
      },
    );
    await fancy.forceFlush();

    // The override is lifted out of the arguments entirely, not merely hidden
    // — the vendor receives exactly the params the caller wrote, minus it.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 100,
      system: "You are support.",
      messages: [{ role: "user", content: "Refund invoice 4412" }],
    });

    expect(receiver.received).toHaveLength(1);
    const req = receiver.received[0];
    expect(req.headers.authorization).toBe("Bearer fs_test_contract");
    const body = req.body as OtlpExportRequest;
    const rs = body.resourceSpans[0];
    expect(attr(rs.resource.attributes, "service.name")).toEqual({ stringValue: "contract-app" });
    expect(attr(rs.resource.attributes, "service.version")).toEqual({ stringValue: "0.0.1" });
    expect(attr(rs.resource.attributes, "fancysauce.schema_version")).toEqual({
      stringValue: "1.0.0",
    });
    // Pinned as present rather than by value: the version tracks the package.
    expect(attr(rs.resource.attributes, "fancysauce.sdk.version")).toBeDefined();
    expect(attr(rs.resource.attributes, "fancysauce.attribution.environment")).toEqual({
      stringValue: "test",
    });

    expect(rs.scopeSpans).toHaveLength(1);
    const scope = rs.scopeSpans[0];
    expect(scope.scope.name).toContain("instrumentation-anthropic");
    expect(scope.spans).toHaveLength(1);
    const span = scope.spans[0];
    const a = span.attributes;

    expect(attr(a, "gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attr(a, "gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attr(a, "gen_ai.request.model")).toEqual({ stringValue: "claude-sonnet-5" });
    expect(attr(a, "gen_ai.request.max_tokens")).toEqual({ intValue: 100 });
    expect(attr(a, "gen_ai.response.model")).toEqual({ stringValue: "claude-sonnet-5" });
    // The JSON exporter writes an integer attribute as a JSON number, not as
    // the quoted int64 the OTLP JSON mapping also allows.
    expect(attr(a, "gen_ai.usage.input_tokens")).toEqual({ intValue: 1842 });
    expect(attr(a, "gen_ai.usage.output_tokens")).toEqual({ intValue: 376 });
    expect(attr(a, "gen_ai.usage.total_tokens")).toEqual({ intValue: 2218 });
    // Both cache tiers are their own attribute, and neither is folded into
    // input_tokens — the ingest prices them separately.
    expect(attr(a, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: 12488 });
    expect(attr(a, "gen_ai.usage.cache_creation.input_tokens")).toEqual({ intValue: 512 });

    expect(attr(a, "fancysauce.attribution.environment")).toEqual({ stringValue: "test" });
    expect(attr(a, "fancysauce.attribution.customer")).toEqual({ stringValue: "acme-42" });
    expect(attr(a, "fancysauce.attribution.product")).toEqual({ stringValue: "support-chat" });
    expect(attr(a, "fancysauce.attribution.feature")).toEqual({ stringValue: "refund-handling" });
    expect(attr(a, "fancysauce.metadata.ticket")).toEqual({ stringValue: "ZD-88213" });
    expect(attr(a, "gen_ai.conversation.id")).toEqual({ stringValue: "conv_8f31a2" });
    expect(attr(a, "session.id")).toEqual({ stringValue: "conv_8f31a2" });
    expect(attr(a, "user.email")).toEqual({ stringValue: "j.park@example.com" });

    // Content arrives under the current GenAI names, which is what the content
    // policy strips by; there is no legacy gen_ai.prompt.N / completion.N pair.
    // The system prompt is its own attribute rather than an input message.
    expect(attr(a, "gen_ai.system_instructions")).toEqual({
      stringValue: JSON.stringify([{ type: "text", content: "You are support." }]),
    });
    expect(attr(a, "gen_ai.input.messages")).toEqual({
      stringValue: JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "Refund invoice 4412" }] },
      ]),
    });
    expect(attr(a, "gen_ai.output.messages")).toEqual({
      stringValue: JSON.stringify([
        {
          role: "assistant",
          finish_reason: "stop",
          parts: [{ type: "text", content: "Refund started for invoice 4412." }],
        },
      ]),
    });
    expect(attr(a, "gen_ai.prompt.0.content")).toBeUndefined();
    expect(attr(a, "gen_ai.completion.0.content")).toBeUndefined();

    // Advisory and recomputed by the ingest: the UTF-8 size of the content
    // attributes as they were exported.
    expect(attr(a, "fancysauce.content.bytes")).toEqual({ intValue: contentBytes(a) });

    recordOrCompare(join(OUT, "anthropic-messages.otlp.json"), req.body);
  });

  /**
   * `messages.parse()` is not in ANTHROPIC_METHODS and OpenLLMetry does not
   * patch it, yet a call through it is covered today — because the generated
   * client writes `parse()` as `this.create(params, options).then(…)`, so the
   * call passes through the instance wrapper this SDK installs on `create` and
   * then through the patched prototype. That is how one release of the vendor
   * SDK happens to be generated, not a contract it offers. A release that had
   * `parse()` post to the transport itself would take the span and the
   * attribution with it, without an error anywhere, for every caller that asks
   * for structured output. This case is the alarm for that.
   */
  it("ships one span for messages.parse, with the structured output intact", async () => {
    // The receiver and the fake provider are shared by the whole suite, so
    // what this case owns is the tail of each, not the whole array.
    const exportsBefore = receiver.received.length;
    const callsBefore = provider.requests.length;

    const anthropic = fancy.instrument(
      new Anthropic({ apiKey: "sk-ant-test", baseURL: provider.baseURL }),
      { attribution: { product: "invoice-ops" } },
    );
    await fancy.instrument.ready();

    const InvoiceFields = z.object({
      invoice_id: z.string(),
      amount_cents: z.number().int(),
      currency: z.string(),
    });

    // Held in a variable rather than written inline for two reasons: the
    // per-call override is not in the vendor's parameter type, and `parse()`
    // infers the parsed type from the params it is given — the cast the
    // create() case uses would erase it and leave `parsed_output` as null.
    const params = {
      model: "claude-sonnet-5",
      max_tokens: 100,
      system: "You are support.",
      messages: [{ role: "user" as const, content: "Refund invoice 4412" }],
      output_config: { format: zodOutputFormat(InvoiceFields) },
      fancysauce: { feature: "refund-handling" },
    };

    const message = await fancy.attribute(
      { customer: "acme-42", conversation: "conv_8f31a2", member: "j.park@example.com" },
      { metadata: { ticket: "ZD-88213" } },
      () => anthropic.messages.parse(params),
    );
    await fancy.forceFlush();

    // The round trip: the JSON the server answered with, read back through the
    // schema and handed to the caller as an object. Reading a field off it is
    // also the type assertion — the field only exists on `parsed_output` when
    // the format's type reached it.
    expect(message.parsed_output).toEqual(ANTHROPIC_STRUCTURED_OUTPUT);
    expect(message.parsed_output?.currency).toBe("USD");

    expect(provider.requests).toHaveLength(callsBefore + 1);
    const { output_config: format, ...sent } = provider.requests[callsBefore] as {
      output_config?: { format?: { type?: string; schema?: { properties?: object } } };
    };
    // toEqual rather than toMatchObject: the per-call override is lifted out
    // of the body on this path too, and a `fancysauce` key left behind — which
    // is what an unwrapped parse() would leave — fails an exact match.
    expect(sent).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 100,
      system: "You are support.",
      messages: [{ role: "user", content: "Refund invoice 4412" }],
    });
    // The format crosses the wire as JSON schema; the `parse` function the
    // helper attaches to it is local to the client and cannot. Asserted by
    // shape and not by value, because the schema JSON itself is the emitter's
    // business and not this contract's.
    expect(format?.format?.type).toBe("json_schema");
    expect(Object.keys(format?.format?.schema?.properties ?? {})).toEqual([
      "invoice_id",
      "amount_cents",
      "currency",
    ]);
    expect(format?.format).not.toHaveProperty("parse");

    expect(receiver.received).toHaveLength(exportsBefore + 1);
    const req = receiver.received[exportsBefore];
    const body = req.body as OtlpExportRequest;
    const rs = body.resourceSpans[0];
    expect(rs.scopeSpans).toHaveLength(1);
    const scope = rs.scopeSpans[0];
    expect(scope.scope.name).toContain("instrumentation-anthropic");
    // The whole point of the case: one span. Zero is the regression it guards
    // against; two would mean parse() and the create() under it each produced
    // one and the call is being billed twice.
    expect(scope.spans).toHaveLength(1);
    const a = scope.spans[0].attributes;

    // Identical to the create() case: a structured-output call is the same
    // call to the ingest, and nothing about the model, the usage, or the cache
    // tiers may change shape because the caller asked for a schema.
    expect(attr(a, "gen_ai.provider.name")).toEqual({ stringValue: "anthropic" });
    expect(attr(a, "gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attr(a, "gen_ai.request.model")).toEqual({ stringValue: "claude-sonnet-5" });
    expect(attr(a, "gen_ai.request.max_tokens")).toEqual({ intValue: 100 });
    expect(attr(a, "gen_ai.response.model")).toEqual({ stringValue: "claude-sonnet-5" });
    expect(attr(a, "gen_ai.usage.input_tokens")).toEqual({ intValue: 1842 });
    expect(attr(a, "gen_ai.usage.output_tokens")).toEqual({ intValue: 376 });
    expect(attr(a, "gen_ai.usage.total_tokens")).toEqual({ intValue: 2218 });
    expect(attr(a, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: 12488 });
    expect(attr(a, "gen_ai.usage.cache_creation.input_tokens")).toEqual({ intValue: 512 });

    expect(attr(a, "fancysauce.attribution.environment")).toEqual({ stringValue: "test" });
    expect(attr(a, "fancysauce.attribution.customer")).toEqual({ stringValue: "acme-42" });
    expect(attr(a, "fancysauce.attribution.product")).toEqual({ stringValue: "invoice-ops" });
    expect(attr(a, "fancysauce.attribution.feature")).toEqual({ stringValue: "refund-handling" });
    expect(attr(a, "fancysauce.metadata.ticket")).toEqual({ stringValue: "ZD-88213" });
    expect(attr(a, "gen_ai.conversation.id")).toEqual({ stringValue: "conv_8f31a2" });
    expect(attr(a, "session.id")).toEqual({ stringValue: "conv_8f31a2" });
    expect(attr(a, "user.email")).toEqual({ stringValue: "j.park@example.com" });

    // The answer is JSON, and it rides in the same content attribute prose
    // would — the content policy has one thing to strip either way.
    expect(attr(a, "gen_ai.output.messages")).toEqual({
      stringValue: JSON.stringify([
        {
          role: "assistant",
          finish_reason: "stop",
          parts: [{ type: "text", content: JSON.stringify(ANTHROPIC_STRUCTURED_OUTPUT) }],
        },
      ]),
    });
    expect(attr(a, "fancysauce.content.bytes")).toEqual({ intValue: contentBytes(a) });

    recordOrCompare(join(OUT, "anthropic-messages-parse.otlp.json"), req.body);
  });
});
