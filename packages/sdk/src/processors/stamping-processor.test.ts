/* eslint-disable @typescript-eslint/require-await -- the callbacks below are
   deliberately async with nothing to await: what is under test is that a span
   started inside an async scope still sees it. */
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { AttributionContext } from "../attribution/context.js";
import { StampingProcessor } from "./stamping-processor.js";

function setup() {
  const ctx = new AttributionContext({ mode: "auto" });
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new StampingProcessor(ctx), new SimpleSpanProcessor(exporter)],
  });
  return { ctx, exporter, tracer: provider.getTracer("test") };
}

describe("StampingProcessor", () => {
  it("copies the active bag, metadata, and reserved attributes onto a new span", async () => {
    const { ctx, exporter, tracer } = setup();
    await ctx.attribute(
      { customer: "acme", conversation: "c1", member: "j@x.io" },
      { metadata: { ticket: "T-1" } },
      async () => {
        tracer.startSpan("chat").end();
      },
    );
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(attrs["fancysauce.attribution.customer"]).toBe("acme");
    expect(attrs["fancysauce.metadata.ticket"]).toBe("T-1");
    expect(attrs["gen_ai.conversation.id"]).toBe("c1");
    expect(attrs["session.id"]).toBe("c1");
    expect(attrs["user.email"]).toBe("j@x.io");
  });

  it("does not overwrite standard attributes the instrumentation already set on start", () => {
    const { ctx, exporter, tracer } = setup();
    ctx.attribute({ conversation: "from-bag" }, () => {
      tracer
        .startSpan("chat", { attributes: { "gen_ai.conversation.id": "from-instrumentation" } })
        .end();
    });
    expect(exporter.getFinishedSpans()[0].attributes["gen_ai.conversation.id"]).toBe(
      "from-instrumentation",
    );
  });

  it("replaces a reserved key outright instead of keeping both attributes it can map to", async () => {
    const { ctx, exporter, tracer } = setup();
    await ctx.attribute({ member: "j.park@example.com", conversation: "c1" }, async () => {
      await ctx.attribute({ member: "u_9", conversation: "c2" }, async () => {
        tracer.startSpan("chat").end();
      });
    });
    const attrs = exporter.getFinishedSpans()[0].attributes;
    // The outer member is an email and the inner one an id, so the two expand
    // to different attributes; only the inner one belongs on the span.
    expect(attrs["user.id"]).toBe("u_9");
    expect(attrs["user.email"]).toBeUndefined();
    expect(attrs["gen_ai.conversation.id"]).toBe("c2");
    expect(attrs["session.id"]).toBe("c2");
  });

  it("stamps nothing when no scope is active", () => {
    const { exporter, tracer } = setup();
    tracer.startSpan("chat").end();
    expect(Object.keys(exporter.getFinishedSpans()[0].attributes)).toEqual([]);
  });

  it("stamps child spans created inside the scope, including after an await", async () => {
    const { ctx, exporter, tracer } = setup();
    await ctx.attribute({ customer: "acme" }, async () => {
      const parent = tracer.startSpan("parent");
      await Promise.resolve();
      tracer.startSpan("child").end();
      parent.end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(2);
    for (const s of exporter.getFinishedSpans())
      expect(s.attributes["fancysauce.attribution.customer"]).toBe("acme");
  });
});
