import type { Context } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnostics } from "../diagnostics.js";
import { createScopeAllowList, ScopeFilterProcessor } from "./scope-filter-processor.js";

function setup(allowed: Iterable<string> = ["ai"]) {
  const exporter = new InMemorySpanExporter();
  const scopes = new Set(allowed);
  const filter = new ScopeFilterProcessor(new SimpleSpanProcessor(exporter), scopes);
  const provider = new BasicTracerProvider({ spanProcessors: [filter] });
  const exported = (): string[] => exporter.getFinishedSpans().map((s) => s.name);
  return { exported, filter, provider, scopes };
}

/** Records what a wrapped processor was asked to do, and nothing else. */
function recorder() {
  const calls: string[] = [];
  const inner: SpanProcessor = {
    onStart: (_span: Span, _parent: Context) => calls.push("onStart"),
    onEnd: (_span: ReadableSpan) => calls.push("onEnd"),
    forceFlush: () => {
      calls.push("forceFlush");
      return Promise.resolve();
    },
    shutdown: () => {
      calls.push("shutdown");
      return Promise.resolve();
    },
  };
  return { calls, inner };
}

describe("ScopeFilterProcessor", () => {
  afterEach(() => {
    resetDiagnostics();
    vi.restoreAllMocks();
  });

  it("forwards a span from an allowed scope and drops one from anything else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { exported, provider } = setup();
    provider.getTracer("ai").startSpan("generateText").end();
    provider.getTracer("my-app").startSpan("handle-request").end();
    expect(exported()).toEqual(["generateText"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("names the scope once, and counts every span it drops for it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { filter, provider } = setup();
    provider.getTracer("my-app").startSpan("handle-request").end();
    provider.getTracer("my-app").startSpan("query-db").end();
    provider.getTracer("my-orm").startSpan("select").end();
    // One warning per scope, however many spans it sends: a chatty
    // instrumentation must not narrate the host's logs.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('"my-app"');
    expect(warn.mock.calls[0][0]).toContain("registerProvider");
    expect(warn.mock.calls[1][0]).toContain('"my-orm"');
    expect([...filter.dropped()]).toEqual([
      ["my-app", 2],
      ["my-orm", 1],
    ]);
  });

  it("reads the allow-list at span end, so a scope added later is honored", () => {
    const { exported, provider, scopes } = setup();
    // instrument() grows the set as each instrumentation package lands, which
    // is long after init() built the processors around it.
    scopes.add("@traceloop/instrumentation-openai");
    provider.getTracer("@traceloop/instrumentation-openai").startSpan("chat").end();
    expect(exported()).toEqual(["chat"]);
  });

  it("seeds the scopes the Vercel AI SDK's spans can carry", () => {
    const { exported, provider } = setup(createScopeAllowList());
    provider.getTracer("ai").startSpan("v7").end();
    provider.getTracer("@fancysauce/sdk/vercel-ai").startSpan("v5").end();
    expect(exported()).toEqual(["v7", "v5"]);
  });

  it("delegates onStart, forceFlush and shutdown to the processor it wraps", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { calls, inner } = recorder();
    const filter = new ScopeFilterProcessor(inner, new Set());
    // onStart is forwarded whatever the scope is: it is the only point a
    // processor may still write to a live span, and the drop belongs at the
    // end, where the wrapped processor would enqueue it.
    new BasicTracerProvider({ spanProcessors: [filter] }).getTracer("my-app").startSpan("x").end();
    await filter.forceFlush();
    await filter.shutdown();
    expect(calls).toEqual(["onStart", "forceFlush", "shutdown"]);
  });
});
