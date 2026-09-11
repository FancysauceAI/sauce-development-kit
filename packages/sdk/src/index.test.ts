import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnostics } from "./diagnostics.js";
import { fancy } from "./index.js";
import { createSdk } from "./init.js";
import type { ClassPatch } from "./instrument/registry.js";
import { vercelTelemetry } from "./vercel.js";

/**
 * An OpenAI-shaped client whose method lives where a class patch would land.
 * Built per test, because the patch below mutates the prototype: sharing one
 * class would carry a test's spans into the next one.
 */
function fakeOpenAI() {
  class Completions {
    create(body: unknown): Promise<string> {
      void body;
      return Promise.resolve("ok");
    }
  }
  class Chat {
    completions = new Completions();
  }
  class FakeOpenAI {
    chat = new Chat();
  }
  return { FakeOpenAI, Completions };
}

/** Stands in for OpenLLMetry: the class patch is what creates the span. */
const spanningPatch =
  (
    Completions: ReturnType<typeof fakeOpenAI>["Completions"],
    seen: { traceContent?: boolean } = {},
  ): ClassPatch =>
  (_provider, _ctor, tracerProvider, traceContent) => {
    seen.traceContent = traceContent;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the caller's `this`
    const original = Completions.prototype.create;
    Completions.prototype.create = function (body: unknown) {
      const span = tracerProvider.getTracer("openllmetry").startSpan("chat");
      try {
        return original.call(this, body);
      } finally {
        span.end();
      }
    };
    return Promise.resolve(true);
  };

describe("the fancy object", () => {
  let sdk: ReturnType<typeof createSdk> | undefined;

  afterEach(async () => {
    await fancy.shutdown();
    await sdk?.shutdown();
    sdk = undefined;
    trace.disable();
    context.disable();
    resetDiagnostics();
    vi.restoreAllMocks();
  });

  it("exposes the documented surface", () => {
    expect(typeof fancy.init).toBe("function");
    expect(typeof fancy.attribute).toBe("function");
    expect(typeof fancy.attribute.start).toBe("function");
    expect(typeof fancy.attribute.add).toBe("function");
    expect(typeof fancy.attribute.end).toBe("function");
    expect(typeof fancy.instrument).toBe("function");
    expect(typeof fancy.vercelTelemetry).toBe("function");
    expect(typeof fancy.spanProcessors).toBe("function");
    expect(typeof fancy.forceFlush).toBe("function");
    expect(typeof fancy.shutdown).toBe("function");
  });

  it("hands the Vercel AI SDK the content policy init() resolved, and warns before there is one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Before init() the content policy cannot be known, and the object freezes
    // whatever it was built with, so recording inputs is both the default and
    // worth a warning.
    expect(fancy.vercelTelemetry().recordInputs).toBe(true);
    fancy.vercelTelemetry();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/before fancy\.init\(\)/);
    fancy.init({ apiKey: "fs_test_x", endpoint: "http://127.0.0.1:1", content: "none" });
    const telemetry = fancy.vercelTelemetry();
    expect(telemetry.isEnabled).toBe(true);
    expect(telemetry.recordInputs).toBe(false);
    expect(telemetry.recordOutputs).toBe(false);
    expect(telemetry.tracer).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("exports the same bound helper from the ./vercel subpath", () => {
    expect(vercelTelemetry).toBe(fancy.vercelTelemetry);
  });

  it("refuses to instrument a client before init()", () => {
    const { FakeOpenAI } = fakeOpenAI();
    expect(() => fancy.instrument(new FakeOpenAI())).toThrow(/fancy\.init\(\) first/);
  });

  it("carries the client's attribution and the enclosing scope onto the span", async () => {
    const mem = new InMemorySpanExporter();
    const { FakeOpenAI, Completions } = fakeOpenAI();
    sdk = createSdk({
      exporterFactory: () => mem,
      instrumentPatch: spanningPatch(Completions),
    });
    sdk.init({ apiKey: "fs_test_x" });
    const client = sdk.instrument(new FakeOpenAI(), { attribution: { product: "p" } });
    await sdk.attribute({ customer: "c" }, () => client.chat.completions.create({ model: "m" }));
    await sdk.forceFlush();
    const span = mem.getFinishedSpans()[0];
    expect(span.name).toBe("chat");
    expect(span.attributes["fancysauce.attribution.product"]).toBe("p");
    expect(span.attributes["fancysauce.attribution.customer"]).toBe("c");
  });

  it("turns off the instrumentation's content capture when init() did", () => {
    const seen: { traceContent?: boolean } = {};
    const { FakeOpenAI, Completions } = fakeOpenAI();
    sdk = createSdk({
      exporterFactory: () => new InMemorySpanExporter(),
      instrumentPatch: spanningPatch(Completions, seen),
    });
    sdk.init({ apiKey: "fs_test_x", content: "none" });
    sdk.instrument(new FakeOpenAI());
    expect(seen.traceContent).toBe(false);
  });

  it("attributes into the live context when a client is instrumented again after a restart", async () => {
    const restarted = new InMemorySpanExporter();
    const pool = [new InMemorySpanExporter(), restarted];
    const { FakeOpenAI, Completions } = fakeOpenAI();
    sdk = createSdk({
      exporterFactory: () => pool.shift()!,
      instrumentPatch: spanningPatch(Completions),
    });
    sdk.init({ apiKey: "fs_test_x" });
    const client = sdk.instrument(new FakeOpenAI(), { attribution: { product: "p" } });
    await sdk.shutdown();
    sdk.init({ apiKey: "fs_test_x" });
    sdk.instrument(client, { attribution: { product: "p" } });
    await sdk.attribute({ customer: "c" }, () => client.chat.completions.create({ model: "m" }));
    await sdk.forceFlush();
    // The wrapper installed before the restart is the one still on the client;
    // reading the context out of its tag is what lets the second instrument()
    // repoint it. A wrapper holding the context the shutdown retired would
    // export this span with neither key.
    const span = restarted.getFinishedSpans().at(-1);
    expect(span?.attributes["fancysauce.attribution.product"]).toBe("p");
    expect(span?.attributes["fancysauce.attribution.customer"]).toBe("c");
  });

  it("keeps attribute.start/add/end stamping after a restart", async () => {
    const restarted = new InMemorySpanExporter();
    const pool = [new InMemorySpanExporter(), restarted];
    sdk = createSdk({ exporterFactory: () => pool.shift()! });
    // The callable `fancy.attribute` is: composing the three forms over one
    // context that a restart replaces underneath them.
    const { attribute } = sdk;
    sdk.init({ apiKey: "fs_test_x" });
    await sdk.shutdown();
    sdk.init({ apiKey: "fs_test_x" });
    const tracer = trace.getTracer("app");
    attribute.start({ customer: "acme" });
    attribute.add({ feature: "search" });
    tracer.startSpan("scoped").end();
    attribute.end("feature");
    tracer.startSpan("narrowed").end();
    attribute.end();
    tracer.startSpan("bare").end();
    await sdk.forceFlush();
    const byName = new Map(restarted.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("scoped")?.["fancysauce.attribution.customer"]).toBe("acme");
    expect(byName.get("scoped")?.["fancysauce.attribution.feature"]).toBe("search");
    expect(byName.get("narrowed")?.["fancysauce.attribution.feature"]).toBeUndefined();
    expect(byName.get("narrowed")?.["fancysauce.attribution.customer"]).toBe("acme");
    expect(byName.get("bare")?.["fancysauce.attribution.customer"]).toBeUndefined();
  });
});
