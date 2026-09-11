import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { resetDiagnostics } from "./diagnostics.js";
import { fancy } from "./index.js";
import { createSdk } from "./init.js";
import type { ClassPatch } from "./instrument/registry.js";

/** An OpenAI-shaped client whose method lives where a class patch would land. */
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

/** Stands in for OpenLLMetry: the class patch is what creates the span. */
const spanningPatch =
  (seen: { traceContent?: boolean } = {}): ClassPatch =>
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

  it("hands the Vercel AI SDK the content policy init() resolved", () => {
    // Before init(), the default policy — the same one init() would resolve.
    expect(fancy.vercelTelemetry().recordInputs).toBe(true);
    fancy.init({ apiKey: "fs_test_x", endpoint: "http://127.0.0.1:1", content: "none" });
    const telemetry = fancy.vercelTelemetry();
    expect(telemetry.isEnabled).toBe(true);
    expect(telemetry.recordInputs).toBe(false);
    expect(telemetry.recordOutputs).toBe(false);
    expect(telemetry.tracer).toBeDefined();
  });

  it("refuses to instrument a client before init()", () => {
    expect(() => fancy.instrument(new FakeOpenAI())).toThrow(/fancy\.init\(\) first/);
  });

  it("carries the client's attribution and the enclosing scope onto the span", async () => {
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem, instrumentPatch: spanningPatch() });
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
    sdk = createSdk({
      exporterFactory: () => new InMemorySpanExporter(),
      instrumentPatch: spanningPatch(seen),
    });
    sdk.init({ apiKey: "fs_test_x", content: "none" });
    sdk.instrument(new FakeOpenAI());
    expect(seen.traceContent).toBe(false);
  });
});
