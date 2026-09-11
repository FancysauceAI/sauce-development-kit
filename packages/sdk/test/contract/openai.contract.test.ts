/**
 * The OpenAI half of the wire contract: a real `openai` client, a fake OpenAI
 * server, and a fake collector, so what is asserted is the OTLP/HTTP JSON the
 * SDK actually posts rather than an in-memory span.
 *
 * The first run records `out/openai-chat.otlp.json`, which the ingest vendors
 * as a fixture; every run after that compares against it via
 * `recordOrCompare` (see recording.ts), blanking only what a run mints or the
 * package version supplies — `traceId`, `spanId`, `parentSpanId`,
 * `startTimeUnixNano`, `endTimeUnixNano`, and the `fancysauce.sdk.version`
 * resource attribute. The recorded file itself keeps its real-shaped ids,
 * timestamps and version, so the ingest still has something realistic to
 * parse against.
 * Set RECORD_CONTRACT=1 to re-record after an intentional shape change.
 */
import { join } from "node:path";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fancy } from "../../src/index.js";
import { startFakeOpenAI } from "./fake-openai.js";
import { attr, startReceiver, type OtlpExportRequest } from "./otlp-receiver.js";
import { recordOrCompare } from "./recording.js";

const OUT = join(import.meta.dirname, "out");
const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages"];

describe("OpenAI end to end", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let provider: Awaited<ReturnType<typeof startFakeOpenAI>>;

  beforeAll(async () => {
    receiver = await startReceiver();
    provider = await startFakeOpenAI();
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

  it("ships a chat span with usage, attribution, content, and the resource contract", async () => {
    const openai = fancy.instrument(new OpenAI({ apiKey: "sk-test", baseURL: provider.baseURL }), {
      attribution: { product: "support-chat" },
    });
    // The class patch loads its instrumentation package on demand, so a call
    // made before it lands carries attribution but produces no span.
    await fancy.instrument.ready();
    await fancy.attribute(
      { customer: "acme-42", conversation: "conv_8f31a2", member: "j.park@example.com" },
      { metadata: { ticket: "ZD-88213" } },
      async () => {
        await openai.chat.completions.create(
          {
            model: "gpt-5-mini",
            messages: [
              { role: "system", content: "You are support." },
              { role: "user", content: "Refund invoice 4412" },
            ],
          },
          // The override rides on the request options here and on the request
          // body in the Anthropic suite, so both carriers are covered. The
          // provider SDKs' option types are closed, hence the assertion.
          { fancysauce: { feature: "refund-handling" } } as OpenAI.RequestOptions,
        );
      },
    );
    await fancy.forceFlush();

    // The override is lifted out of the arguments entirely, not merely hidden
    // — the vendor receives exactly the request the caller wrote.
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toEqual({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are support." },
        { role: "user", content: "Refund invoice 4412" },
      ],
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
    expect(scope.scope.name).toContain("instrumentation-openai");
    expect(scope.spans).toHaveLength(1);
    const span = scope.spans[0];
    const a = span.attributes;

    expect(attr(a, "gen_ai.provider.name")).toEqual({ stringValue: "openai" });
    expect(attr(a, "gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attr(a, "gen_ai.request.model")).toEqual({ stringValue: "gpt-5-mini" });
    expect(attr(a, "gen_ai.response.model")).toEqual({ stringValue: "gpt-5-mini-2026-06-01" });
    expect(attr(a, "gen_ai.response.id")).toEqual({ stringValue: "chatcmpl-fixture-1" });
    // The JSON exporter writes an integer attribute as a JSON number, not as
    // the quoted int64 the OTLP JSON mapping also allows.
    expect(attr(a, "gen_ai.usage.input_tokens")).toEqual({ intValue: 1842 });
    expect(attr(a, "gen_ai.usage.output_tokens")).toEqual({ intValue: 376 });
    expect(attr(a, "gen_ai.usage.total_tokens")).toEqual({ intValue: 2218 });
    // The response reports 1200 cached prompt tokens and the instrumentation
    // does not carry them, so the OpenAI cache tier has no span attribute to
    // read. The Anthropic suite pins the two that do exist.
    expect(attr(a, "gen_ai.usage.cache_read.input_tokens")).toBeUndefined();

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
    expect(attr(a, "gen_ai.input.messages")).toEqual({
      stringValue: JSON.stringify([
        { role: "system", parts: [{ type: "text", content: "You are support." }] },
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
    const contentBytes = CONTENT_KEYS.reduce(
      (total, key) => total + Buffer.byteLength(String(attr(a, key)?.stringValue), "utf8"),
      0,
    );
    expect(attr(a, "fancysauce.content.bytes")).toEqual({ intValue: contentBytes });

    recordOrCompare(join(OUT, "openai-chat.otlp.json"), req.body);
  });
});
