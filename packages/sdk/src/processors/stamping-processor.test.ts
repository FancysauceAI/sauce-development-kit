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
