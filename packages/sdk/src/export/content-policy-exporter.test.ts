import { describe, expect, it } from "vitest";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ContentPolicyExporter } from "./content-policy-exporter.js";

class CaptureExporter implements SpanExporter {
  batches: ReadableSpan[][] = [];
  failWith: number | null = null;
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.batches.push(spans);
    if (this.failWith !== null && spans.length > 1) {
      const err = Object.assign(new Error("Request Entity Too Large"), { code: this.failWith });
      cb({ code: ExportResultCode.FAILED, error: err });
      return;
    }
    cb({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

function spanWith(attrs: Record<string, string>): ReadableSpan {
  const mem = new InMemorySpanExporter();
  const p = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(mem)] });
  p.getTracer("t").startSpan("chat", { attributes: attrs }).end();
  return mem.getFinishedSpans()[0];
}

const exportOnce = (ex: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise<ExportResult>((resolve) => ex.export(spans, resolve));

describe("ContentPolicyExporter", () => {
  it("content: none strips the three content attributes and nothing else", async () => {
    const inner = new CaptureExporter();
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [
      spanWith({
        "gen_ai.input.messages": "[…]",
        "gen_ai.output.messages": "[…]",
        "gen_ai.system_instructions": "x",
        "gen_ai.request.model": "m",
      }),
    ]);
    expect(inner.batches[0][0].attributes).toEqual({ "gen_ai.request.model": "m" });
  });

  it("content: full keeps content, runs redact, and caps oversized attributes with a marker", async () => {
    const inner = new CaptureExporter();
    const ex = new ContentPolicyExporter(inner, {
      content: "full",
      redact: (value) => value.replaceAll("SECRET", "[redacted]"),
      maxBytes: 16,
    });
    await exportOnce(ex, [
      spanWith({
        "gen_ai.input.messages": "say SECRET",
        "gen_ai.output.messages": "x".repeat(100),
      }),
    ]);
    const attrs = inner.batches[0][0].attributes;
    expect(attrs["gen_ai.input.messages"]).toBe("say [redacted]");
    expect(
      Buffer.byteLength(attrs["gen_ai.output.messages"] as string, "utf8"),
    ).toBeLessThanOrEqual(16);
    expect(attrs["fancysauce.content.truncated"]).toBe(true);
  });

  it("truncation never leaves a broken UTF-8 tail", async () => {
    const inner = new CaptureExporter();
    await exportOnce(new ContentPolicyExporter(inner, { content: "full", maxBytes: 5 }), [
      spanWith({ "gen_ai.input.messages": "ab😀cd" }),
    ]);
    const v = inner.batches[0][0].attributes["gen_ai.input.messages"] as string;
    expect(v).toBe("ab");
    expect(v.includes("�")).toBe(false);
  });

  it("never mutates the original span", async () => {
    const inner = new CaptureExporter();
    const s = spanWith({ "gen_ai.input.messages": "keep" });
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [s]);
    expect(s.attributes["gen_ai.input.messages"]).toBe("keep");
  });

  it("keeps the span's methods and fields reachable on the sanitized copy", async () => {
    const inner = new CaptureExporter();
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [spanWith({ a: "b" })]);
    const copy = inner.batches[0][0];
    expect(typeof copy.spanContext).toBe("function");
    expect(copy.spanContext().traceId).toHaveLength(32);
    expect(copy.name).toBe("chat");
    expect(copy.resource).toBeDefined();
    expect(copy.instrumentationScope.name).toBe("t");
  });

  it("on HTTP 413 splits the batch in halves and retries", async () => {
    const inner = new CaptureExporter();
    inner.failWith = 413;
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
      spanWith({ a: "3" }),
    ]);
    expect(r.code).toBe(ExportResultCode.SUCCESS);
    // 3 fails, so its first half (ceil(3/2) = 2) goes next; that fails too and
    // splits into two singles, and only then does the trailing single go.
    expect(inner.batches.map((b) => b.length)).toEqual([3, 2, 1, 1, 1]);
  });

  it("a single span that still 413s is reported as failed, not retried forever", async () => {
    const inner = new CaptureExporter();
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      cb({
        code: ExportResultCode.FAILED,
        error: Object.assign(new Error("too large"), { code: 413 }),
      });
    };
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
    ]);
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(inner.batches).toHaveLength(1);
  });

  it("other failures pass through unchanged", async () => {
    const inner = new CaptureExporter();
    inner.failWith = 500;
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
    ]);
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(inner.batches).toHaveLength(1);
  });

  it("recognizes the fetch transport's 413, which carries the status only in the message", async () => {
    const inner = new CaptureExporter();
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      if (spans.length > 1) {
        cb({
          code: ExportResultCode.FAILED,
          error: new Error("Fetch request failed with non-retryable status 413"),
        });
        return;
      }
      cb({ code: ExportResultCode.SUCCESS });
    };
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
    ]);
    expect(r.code).toBe(ExportResultCode.SUCCESS);
    expect(inner.batches.map((b) => b.length)).toEqual([2, 1, 1]);
  });

  it("reports the first half's failure without attempting the second", async () => {
    const inner = new CaptureExporter();
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      if (spans.length > 1) {
        cb({
          code: ExportResultCode.FAILED,
          error: Object.assign(new Error("too large"), { code: 413 }),
        });
        return;
      }
      cb({ code: ExportResultCode.FAILED, error: new Error("network down") });
    };
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
    ]);
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(inner.batches.map((b) => b.length)).toEqual([2, 1]);
  });
});
