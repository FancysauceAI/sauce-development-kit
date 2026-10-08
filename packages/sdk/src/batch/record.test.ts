import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
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
    await sdk.recordBatchResult(base);
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
    await sdk.recordBatchResult(base);
    await sdk.recordBatchResult({
      ...base,
      customId: "request-2",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
      },
    });
    await sdk.recordBatchResult({
      ...base,
      customId: "request-3",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: undefined,
        cacheCreationInputTokens: null,
      },
    });
    await sdk.recordBatchResult({
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
    await sdk.recordBatchResult(base);
    await sdk.forceFlush();
    const first = firstExporter.getFinishedSpans()[0].spanContext();
    await sdk.shutdown();

    const secondExporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => secondExporter });
    sdk.init({ apiKey: "fs_test_x" });
    await sdk.recordBatchResult(base);
    await sdk.recordBatchResult({ ...base, customId: "request-2" });
    await sdk.recordBatchResult({ ...base, provider: "openai" });
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
    await sdk.recordBatchResult({
      ...base,
      attribution: { product: "nightly-digest", member: "a1b2" },
    });
    await sdk.recordBatchResult({
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
      await sdk.recordBatchResult(base);
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
    expect(await sdk.recordBatchResult({ ...base, customId: " " })).toBe(false);
    expect(await sdk.recordBatchResult({ ...base, customId: " " })).toBe(false);
    expect(
      await sdk.recordBatchResult({ ...base, usage: { inputTokens: 0, outputTokens: -1 } }),
    ).toBe(false);
    expect(
      await sdk.recordBatchResult({ ...base, usage: { inputTokens: Number.NaN, outputTokens: 0 } }),
    ).toBe(false);
    expect(
      await sdk.recordBatchResult({ ...base, usage: { inputTokens: 1.5, outputTokens: 0 } }),
    ).toBe(false);
    await sdk.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(3);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.join(" ")).toContain("customId");
    expect(messages.join(" ")).toContain("usage.inputTokens");
    expect(messages.join(" ")).toContain("usage.outputTokens");
    expect(messages.join(" ")).not.toContain("NaN");
  });

  it("warns and returns before init", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    await expect(sdk.recordBatchResult(base)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("before fancy.init()");
  });

  it("clamps a start time later than the end time", async () => {
    const exporter = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    await sdk.recordBatchResult({ ...base, startTime: base.endTime, endTime: base.startTime });
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
    await sdk.recordBatchResult(base);
    await sdk.forceFlush();
    expect(exporter.getFinishedSpans()[0].resource.attributes["service.name"]).toBe("batch-worker");
  });

  it("passes the batch scope filter", async () => {
    const exporter = new InMemorySpanExporter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    await sdk.recordBatchResult(base);
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
      await sdk.recordBatchResult(base);
      await sdk.forceFlush();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env.OTEL_TRACES_SAMPLER;
      else process.env.OTEL_TRACES_SAMPLER = prior;
    }
  });
  it("exports 2,000 sequential results exactly once with matching token totals", async () => {
    const exporter = new InMemorySpanExporter();
    const exportSpans = exporter.export.bind(exporter);
    exporter.export = (spans, callback) => {
      setTimeout(() => exportSpans(spans, callback), 1);
    };
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    for (let i = 0; i < 2_000; i++) {
      expect(
        await sdk.recordBatchResult({
          ...base,
          customId: `request-${i}`,
          usage: { inputTokens: i, outputTokens: 2 },
        }),
      ).toBe(true);
    }
    await sdk.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2_000);
    expect(new Set(spans.map((span) => span.attributes["fancysauce.batch.custom_id"])).size).toBe(
      2_000,
    );
    expect(
      spans.reduce(
        (total, span) => total + Number(span.attributes["gen_ai.usage.input_tokens"]),
        0,
      ),
    ).toBe(1_999_000);
    expect(
      spans.reduce(
        (total, span) => total + Number(span.attributes["gen_ai.usage.output_tokens"]),
        0,
      ),
    ).toBe(4_000);
  });

  it("blocks admission at 64 spans until export completes and keeps flush pending", async () => {
    const exporter = new InMemorySpanExporter();
    const exportSpans = exporter.export.bind(exporter);
    let release!: () => void;
    let started!: () => void;
    const exporting = new Promise<void>((resolve) => (started = resolve));
    let holdFirst = true;
    exporter.export = (spans, callback) => {
      if (!holdFirst) {
        exportSpans(spans, callback);
        return;
      }
      holdFirst = false;
      started();
      void new Promise<void>((resolve) => (release = resolve)).then(() =>
        exportSpans(spans, callback),
      );
    };
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    for (let i = 0; i < 64; i++) await sdk.recordBatchResult({ ...base, customId: `held-${i}` });
    const sixtyFifth = sdk.recordBatchResult({ ...base, customId: "held-64" });
    await exporting;
    let flushed = false;
    const flush = sdk.forceFlush().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);
    let admitted = false;
    void sixtyFifth.then(() => (admitted = true));
    await Promise.resolve();
    expect(admitted).toBe(false);
    release();
    expect(await sixtyFifth).toBe(true);
    await flush;
    expect(exporter.getFinishedSpans()).toHaveLength(65);
  });

  it("latches callback and synchronous exporter failures across lifecycle calls", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.export = (_spans, callback) =>
      callback({ code: ExportResultCode.FAILED, error: new Error("transport failed") });
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    for (let i = 0; i < 64; i++) {
      await expect(sdk.recordBatchResult({ ...base, customId: `failed-${i}` })).resolves.toBe(true);
    }
    await expect(sdk.recordBatchResult({ ...base, customId: "third" })).rejects.toThrow(
      "transport failed",
    );
    await expect(sdk.forceFlush()).rejects.toBeTruthy();
    await expect(sdk.shutdown()).rejects.toBeTruthy();
  });

  it("latches a synchronous exporter throw", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.export = () => {
      throw new Error("export threw");
    };
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    for (let i = 0; i < 64; i++) await sdk.recordBatchResult({ ...base, customId: `throw-${i}` });
    await expect(sdk.recordBatchResult({ ...base, customId: "overflow" })).rejects.toThrow(
      "export threw",
    );
    await expect(sdk.forceFlush()).rejects.toBeTruthy();
    await expect(sdk.shutdown()).rejects.toBeTruthy();
  });
  it("handles empty, partial, full, and overflow chunks through flush and shutdown", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.shutdown = () => Promise.resolve();
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    await sdk.forceFlush();
    for (const count of [1, 63, 64, 65]) {
      for (let i = 0; i < count; i++) {
        await sdk.recordBatchResult({ ...base, customId: `${count}-${i}` });
      }
      if (count !== 65) await sdk.forceFlush();
    }
    await sdk.shutdown();
    expect(exporter.getFinishedSpans()).toHaveLength(193);
  });

  it("keeps attribution separate for concurrent callers across chunks", async () => {
    const exporter = new InMemorySpanExporter();
    const exportSpans = exporter.export.bind(exporter);
    exporter.export = (spans, callback) => {
      setTimeout(() => exportSpans(spans, callback), 1);
    };
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    await Promise.all(
      Array.from({ length: 130 }, (_, i) =>
        sdk!.attribute({ customer: `customer-${i}` }, () =>
          sdk!.recordBatchResult({ ...base, customId: `concurrent-${i}` }),
        ),
      ),
    );
    await sdk.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(130);
    for (const span of spans) {
      const id = String(span.attributes["fancysauce.batch.custom_id"]).replace("concurrent-", "");
      expect(span.attributes["fancysauce.attribution.customer"]).toBe(`customer-${id}`);
    }
  });

  it("latches export timeout", async () => {
    const exporter = new InMemorySpanExporter();
    exporter.export = () => {};
    sdk = createSdk({ exporterFactory: () => exporter });
    sdk.init({ apiKey: "fs_test_x" });
    for (let i = 0; i < 64; i++) await sdk.recordBatchResult({ ...base, customId: `timeout-${i}` });
    vi.useFakeTimers();
    try {
      const admission = sdk.recordBatchResult({ ...base, customId: "timeout-overflow" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(admission).rejects.toThrow("timed out");
      await expect(sdk.forceFlush()).rejects.toBeTruthy();
      await expect(sdk.shutdown()).rejects.toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
