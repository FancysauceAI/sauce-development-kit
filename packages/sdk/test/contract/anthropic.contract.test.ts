/**
 * The Anthropic half of the wire contract: a real `@anthropic-ai/sdk` client, a
 * fake Anthropic server, and a fake collector, so what is asserted is the
 * OTLP/HTTP JSON the SDK actually posts rather than an in-memory span.
 * `out/anthropic-messages.otlp.json` is the recorded shape, which the ingest
 * vendors as a fixture and `recordOrCompare` holds this suite to.
 */
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fancy } from "../../src/index.js";
import { startFakeAnthropic } from "./fake-anthropic.js";
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
      stringValue: "1.0.1",
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
});
