import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPExporterError } from "@opentelemetry/otlp-exporter-base";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ContentPolicyExporter } from "./content-policy-exporter.js";
import { resetDiagnostics } from "../diagnostics.js";

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

/** A child span carrying everything the OTLP span shape has room for. */
function richChildSpan(): { span: ReadableSpan; parentSpanId: string; linkedSpanId: string } {
  const mem = new InMemorySpanExporter();
  const p = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(mem)] });
  const tracer = p.getTracer("t");
  const parent = tracer.startSpan("parent");
  const linked = tracer.startSpan("linked");
  const child = tracer.startSpan(
    "chat",
    {
      attributes: {
        "gen_ai.input.messages": "secret",
        "gen_ai.output.messages": "also secret",
        "gen_ai.request.model": "m",
      },
      links: [{ context: linked.spanContext() }],
    },
    trace.setSpan(ROOT_CONTEXT, parent),
  );
  child.addEvent("first-token");
  child.addEvent("last-token");
  child.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
  child.end();
  return {
    span: mem.getFinishedSpans()[0],
    parentSpanId: parent.spanContext().spanId,
    linkedSpanId: linked.spanContext().spanId,
  };
}

const exportOnce = (ex: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise<ExportResult>((resolve) => ex.export(spans, resolve));

describe("ContentPolicyExporter", () => {
  beforeEach(() => {
    resetDiagnostics();
  });

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

  it("drops the attribute and warns when redact throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new CaptureExporter();
    const ex = new ContentPolicyExporter(inner, {
      content: "full",
      redact: () => {
        throw new Error("regex blew up");
      },
    });
    await exportOnce(ex, [
      spanWith({ "gen_ai.input.messages": "secret", "gen_ai.request.model": "m" }),
    ]);
    expect(inner.batches[0][0].attributes).toEqual({ "gen_ai.request.model": "m" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("redact() threw for gen_ai.input.messages"),
    );
    warn.mockRestore();
  });

  it("drops the attribute and warns when redact returns something other than a string", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new CaptureExporter();
    const ex = new ContentPolicyExporter(inner, {
      content: "full",
      // A redactor that forgets to return is the common shape of this mistake.
      redact: (() => undefined) as unknown as (v: string, a: string) => string,
    });
    await exportOnce(ex, [
      spanWith({ "gen_ai.input.messages": "secret", "gen_ai.request.model": "m" }),
    ]);
    expect(inner.batches[0][0].attributes).toEqual({ "gen_ai.request.model": "m" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("redact() did not return a string for gen_ai.input.messages"),
    );
    warn.mockRestore();
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

  it("passes a span with no content attribute through untouched", async () => {
    const inner = new CaptureExporter();
    const s = spanWith({ "gen_ai.request.model": "m" });
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [s]);
    expect(inner.batches[0][0]).toBe(s);
  });

  it("keeps the span's methods and fields reachable on the sanitized copy", async () => {
    const inner = new CaptureExporter();
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [
      spanWith({ "gen_ai.input.messages": "secret" }),
    ]);
    const copy = inner.batches[0][0];
    expect(typeof copy.spanContext).toBe("function");
    expect(copy.spanContext().traceId).toHaveLength(32);
    expect(copy.name).toBe("chat");
    expect(copy.resource).toBeDefined();
    expect(copy.instrumentationScope.name).toBe("t");
  });

  it("survives OTLP serialization with every span field intact", async () => {
    const { span, parentSpanId, linkedSpanId } = richChildSpan();
    const inner = new CaptureExporter();
    await exportOnce(new ContentPolicyExporter(inner, { content: "none" }), [span]);
    const bytes = JsonTraceSerializer.serializeRequest([inner.batches[0][0]]);
    const request = JSON.parse(new TextDecoder().decode(bytes)) as {
      resourceSpans: {
        scopeSpans: {
          spans: {
            name: string;
            parentSpanId: string;
            attributes: { key: string }[];
            events: unknown[];
            links: { spanId: string }[];
            status: { code: number; message: string };
          }[];
        }[];
      }[];
    };
    const wire = request.resourceSpans[0].scopeSpans[0].spans[0];
    expect(wire.name).toBe("chat");
    expect(wire.parentSpanId).toBe(parentSpanId);
    expect(wire.attributes.map((a) => a.key)).toEqual(["gen_ai.request.model"]);
    expect(wire.events).toHaveLength(2);
    expect(wire.links).toHaveLength(1);
    expect(wire.links[0].spanId).toBe(linkedSpanId);
    expect(wire.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
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

  it("an oversized span at the head of the batch does not block the spans behind it", async () => {
    const inner = new CaptureExporter();
    // Span 1 is over the ingest's limit on its own: every batch holding it
    // 413s, however far the halving descends.
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      if (spans.some((s) => s.attributes.a === "1")) {
        cb({
          code: ExportResultCode.FAILED,
          error: Object.assign(new Error("too large"), { code: 413 }),
        });
        return;
      }
      cb({ code: ExportResultCode.SUCCESS });
    };
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
      spanWith({ a: "3" }),
    ]);
    expect(r.code).toBe(ExportResultCode.FAILED);
    const delivered = inner.batches
      .filter((b) => !b.some((s) => s.attributes.a === "1"))
      .flatMap((b) => b.map((s) => s.attributes.a));
    expect(delivered).toEqual(["2", "3"]);
  });

  it("recognizes the node transport's real 413, an OTLPExporterError carrying the status", async () => {
    const inner = new CaptureExporter();
    // The shape the OTLP/HTTP node transport actually produces, rather than a
    // hand-built stand-in: the status lives on `code`, never on `status`.
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      if (spans.length > 1) {
        cb({
          code: ExportResultCode.FAILED,
          error: new OTLPExporterError("Request Entity Too Large", 413, "batch too large"),
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

  it("recognizes the fetch transport's real 413, a plain Error naming the status", async () => {
    const inner = new CaptureExporter();
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      if (spans.length > 1) {
        cb({
          code: ExportResultCode.FAILED,
          // Verbatim from the fetch transport, which keeps the status only here.
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

  it("an OTLPExporterError for a status that is not 413 passes through unchanged", async () => {
    const inner = new CaptureExporter();
    inner.export = (spans, cb) => {
      inner.batches.push(spans);
      cb({
        code: ExportResultCode.FAILED,
        error: new OTLPExporterError("Internal Server Error", 500, "boom"),
      });
    };
    const r = await exportOnce(new ContentPolicyExporter(inner, { content: "full" }), [
      spanWith({ a: "1" }),
      spanWith({ a: "2" }),
    ]);
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(inner.batches).toHaveLength(1);
  });

  it("skips the second half only when the first half failed for a reason other than 413", async () => {
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
    // A non-413 failure is the collector being unreachable, not this batch
    // being too big; sending the second half would be a second doomed request
    // per level of the descent. A 413 failure means the opposite, so the
    // second half is always attempted there.
    expect(inner.batches.map((b) => b.length)).toEqual([2, 1]);
  });
});
