import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createSdk } from "../init.js";
import { resetDiagnostics } from "../diagnostics.js";
import { batchSpanId, batchTraceId } from "./record.js";

const base = {
  provider: "anthropic",
  batchId: "batch-1",
  customId: "request-1",
  model: "claude-sonnet-5-5",
  responseId: "msg_1",
  finishReason: "end_turn",
  startTime: new Date("2026-10-04T23:30:00Z"),
  endTime: new Date("2026-10-05T00:40:00Z"),
  usage: {
    inputTokens: 12000,
    outputTokens: 1500,
  },
};

describe("recordBatchResult", () => {
  let sdk: ReturnType<typeof createSdk> | undefined;

  afterEach(async () => {
    await sdk?.shutdown();
    sdk = undefined;
    trace.disable();
    resetDiagnostics();
    vi.restoreAllMocks();
  });

  it("exports one client span with the batch usage, tier, and timing", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x", name: "batch-worker", content: "none" });
    sdk.recordBatchResult(base);
    await sdk.forceFlush();

    const [span] = exporter.getFinishedSpans();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(span.name).toBe("chat claude-sonnet-5-5");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.startTime).toEqual([1791156600, 0]);
    expect(span.endTime).toEqual([1791160800, 0]);
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5-5",
      "gen_ai.response.model": "claude-sonnet-5-5",
      "gen_ai.response.id": "msg_1",
      "gen_ai.response.finish_reasons": ["end_turn"],
      "gen_ai.usage.input_tokens": 12000,
      "gen_ai.usage.output_tokens": 1500,
      "fancysauce.batch.id": "batch-1",
      "fancysauce.batch.custom_id": "request-1",
      "fancysauce.service_tier": "batch",
    });
    expect(span.resource.attributes["service.name"]).toBe("batch-worker");
  });

  it("omits absent, undefined, and null cache attributes and exports supplied counts", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    sdk.recordBatchResult(base);
    sdk.recordBatchResult({
      ...base,
      customId: "request-2",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
      },
    });
    sdk.recordBatchResult({
      ...base,
      customId: "request-3",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: undefined,
        cacheCreationInputTokens: null,
      },
    });
    sdk.recordBatchResult({
      ...base,
      customId: "request-4",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: undefined,
      },
    });
    await sdk.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(spans[0].attributes["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
    expect(spans[0].attributes["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    expect(spans[1].attributes).toMatchObject({
      "gen_ai.usage.cache_read.input_tokens": 4,
      "gen_ai.usage.cache_creation.input_tokens": 5,
    });
    for (const span of spans.slice(2)) {
      expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
      expect(span.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    }
  });

  it("keeps deterministic ids across init cycles and separates results and providers", async () => {
    const firstExporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => firstExporter });
    sdk.init({ apiKey: "fs_test_x" });
    sdk.recordBatchResult(base);
    await sdk.forceFlush();
    const first = firstExporter.getFinishedSpans()[0].spanContext();
    await sdk.shutdown();

    const secondExporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => secondExporter });
    sdk.init({ apiKey: "fs_test_x" });
    sdk.recordBatchResult(base);
    sdk.recordBatchResult({ ...base, customId: "request-2" });
    sdk.recordBatchResult({ ...base, provider: "openai" });
    await sdk.forceFlush();
    const spans = secondExporter.getFinishedSpans();
    expect(spans[0].spanContext()).toMatchObject(first);
    expect(spans[1].spanContext().traceId).toBe(first.traceId);
    expect(spans[1].spanContext().spanId).not.toBe(first.spanId);
    expect(spans[2].spanContext().traceId).not.toBe(first.traceId);
    expect(batchTraceId("anthropic", "batch-1")).toBe(first.traceId);
    expect(batchSpanId("anthropic", "batch-1", "request-1")).toBe(first.spanId);
  });

  it("merges init, ambient, and per-result attribution and normalizes member identity", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x", attribution: { environment: "test" } });
    sdk.attribute.start({ product: "ambient" });
    sdk.recordBatchResult({ ...base, attribution: { product: "nightly-digest", member: "a1b2" } });
    sdk.recordBatchResult({
      ...base,
      customId: "request-2",
      attribution: { member: "Dev@Example.com" },
    });
    sdk.attribute.end();
    await sdk.forceFlush();

    expect(exporter.getFinishedSpans()[0].attributes).toMatchObject({
      "fancysauce.attribution.environment": "test",
      "fancysauce.attribution.product": "nightly-digest",
      "user.id": "a1b2",
    });
    expect(exporter.getFinishedSpans()[1].attributes["user.email"]).toBe("dev@example.com");
  });

  it("never exports content under either content mode", async () => {
    for (const content of ["full", "none"] as const) {
      const exporter = new InMemorySpanExporter();
      sdk = createSdk({ exporterFactory: () => exporter });
      sdk.init({ apiKey: "fs_test_x", content });
      sdk.recordBatchResult(base);
      await sdk.forceFlush();
      expect(exporter.getFinishedSpans()[0].attributes).not.toHaveProperty("gen_ai.input.messages");
      expect(exporter.getFinishedSpans()[0].attributes).not.toHaveProperty(
        "gen_ai.output.messages",
      );
      expect(exporter.getFinishedSpans()[0].attributes).not.toHaveProperty(
        "gen_ai.system_instructions",
      );
      await sdk.shutdown();
    }
  });

  it("drops invalid values with one warning and does not throw", async () => {
    const exporter = new InMemorySpanExporter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    expect(() => {
      sdk!.recordBatchResult({ ...base, customId: " " });
      sdk!.recordBatchResult({ ...base, customId: " " });
      sdk!.recordBatchResult({ ...base, usage: { inputTokens: 0, outputTokens: -1 } });
      sdk!.recordBatchResult({ ...base, usage: { inputTokens: Number.NaN, outputTokens: 0 } });
      sdk!.recordBatchResult({ ...base, usage: { inputTokens: 1.5, outputTokens: 0 } });
    }).not.toThrow();
    await sdk.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.join(" ")).toContain("customId");
    expect(messages.join(" ")).toContain("usage.inputTokens");
    expect(messages.join(" ")).toContain("usage.outputTokens");
    expect(messages.join(" ")).not.toContain("NaN");
  });

  it("warns and returns before init", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    expect(() => sdk!.recordBatchResult(base)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("before fancy.init()");
  });

  it("clamps a start time later than the end time", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    sdk.recordBatchResult({ ...base, startTime: base.endTime, endTime: base.startTime });
    await sdk.forceFlush();
    const span = exporter.getFinishedSpans()[0];
    expect(span.startTime).toEqual(span.endTime);
  });

  it("uses the shared processors and resource without registering its provider", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x", name: "batch-worker", registerProvider: false });
    const hostSpan = trace.getTracer("x").startSpan("y");
    expect(hostSpan.isRecording()).toBe(false);
    hostSpan.end();
    sdk.recordBatchResult(base);
    await sdk.forceFlush();
    expect(exporter.getFinishedSpans()[0].resource.attributes["service.name"]).toBe("batch-worker");
  });

  it("passes the batch scope filter", async () => {
    const exporter = new InMemorySpanExporter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    sdk.recordBatchResult(base);
    await sdk.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("was not exported"));
  });

  it("records even when the environment sampler is set to always off", async () => {
    const prior = process.env.OTEL_TRACES_SAMPLER;
    process.env.OTEL_TRACES_SAMPLER = "always_off";
    try {
      const exporter = new InMemorySpanExporter();
      sdk = createSdk({ exporterFactory: () => exporter });
      sdk.init({ apiKey: "fs_test_x" });
      sdk.recordBatchResult(base);
      await sdk.forceFlush();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env.OTEL_TRACES_SAMPLER;
      else process.env.OTEL_TRACES_SAMPLER = prior;
    }
  });
});
