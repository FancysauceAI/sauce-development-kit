import { afterEach, describe, expect, it, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createSdk } from "./init.js";
import { resetDiagnostics } from "./diagnostics.js";

describe("init", () => {
  let sdk: ReturnType<typeof createSdk> | undefined;
  afterEach(async () => {
    await sdk?.shutdown();
    trace.disable();
    resetDiagnostics();
  });

  it("requires an apiKey and an http(s) endpoint", () => {
    sdk = createSdk();
    expect(() => sdk!.init({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => sdk!.init({ apiKey: "k", endpoint: "ingest.example" })).toThrow(/endpoint/);
  });

  it("stamps resource attributes and process defaults, and exports through the policy", async () => {
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem });
    sdk.init({
      apiKey: "fs_test_x",
      name: "support-chat",
      version: "1.2.3",
      attribution: { environment: "prod", member: "ops@example.com" },
      content: "none",
    });
    await sdk.attribute({ customer: "acme" }, async () => {
      // The scope has to outlive an await, which is the whole point of the
      // closure form.
      await Promise.resolve();
      trace
        .getTracer("app")
        .startSpan("chat", { attributes: { "gen_ai.input.messages": "secret" } })
        .end();
    });
    await sdk.forceFlush();
    const span = mem.getFinishedSpans()[0];
    expect(span.resource.attributes["service.name"]).toBe("support-chat");
    expect(span.resource.attributes["service.version"]).toBe("1.2.3");
    expect(span.resource.attributes["fancysauce.schema_version"]).toBe("1.0.0");
    expect(span.resource.attributes["fancysauce.attribution.environment"]).toBe("prod");
    expect(span.resource.attributes["user.email"]).toBe("ops@example.com");
    expect(span.attributes["fancysauce.attribution.customer"]).toBe("acme");
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
  });

  it("is idempotent — a second init warns and keeps the first configuration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    sdk.init({ apiKey: "fs_test_x", name: "one" });
    sdk.init({ apiKey: "fs_test_y", name: "two" });
    expect(sdk.config()?.name).toBe("one");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("more than once"));
    warn.mockRestore();
  });

  it("exposes its processors for applications that own their tracer provider", () => {
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    sdk.init({ apiKey: "fs_test_x" });
    expect(sdk.spanProcessors()).toHaveLength(2);
  });

  it("installs a context manager so spans started inside a parent nest under it", async () => {
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem });
    sdk.init({ apiKey: "fs_test_x" });
    const tracer = trace.getTracer("app");
    const parent = tracer.startSpan("parent");
    context.with(trace.setSpan(context.active(), parent), () => {
      tracer.startSpan("child").end();
    });
    parent.end();
    await sdk.forceFlush();
    const child = mem.getFinishedSpans().find((s) => s.name === "child");
    expect(child?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("hands out an attribute function that survives being destructured before init", async () => {
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem });
    const { attribute } = sdk;
    sdk.init({ apiKey: "fs_test_x" });
    await attribute({ customer: "acme" }, async () => {
      await Promise.resolve();
      trace.getTracer("app").startSpan("chat").end();
    });
    attribute.start({ feature: "search" });
    trace.getTracer("app").startSpan("after-start").end();
    attribute.end();
    await sdk.forceFlush();
    const spans = mem.getFinishedSpans();
    expect(spans[0].attributes["fancysauce.attribution.customer"]).toBe("acme");
    expect(spans[1].attributes["fancysauce.attribution.feature"]).toBe("search");
  });
});
