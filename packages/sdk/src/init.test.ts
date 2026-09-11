import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createSdk } from "./init.js";
import { resetDiagnostics } from "./diagnostics.js";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("init", () => {
  let sdk: ReturnType<typeof createSdk> | undefined;
  afterEach(async () => {
    await sdk?.shutdown();
    trace.disable();
    // A test that installed a context manager through a path shutdown() does
    // not own would otherwise leak it into the next test's probe.
    context.disable();
    resetDiagnostics();
  });

  it("requires an apiKey and an http(s) endpoint", () => {
    sdk = createSdk();
    expect(() => sdk!.init({ apiKey: "" })).toThrow(/apiKey/);
    expect(() => sdk!.init({ apiKey: "fs_test_x", endpoint: "ingest.example" })).toThrow(
      /endpoint/,
    );
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
    expect(span.resource.attributes["fancysauce.sdk.version"]).toBe(PACKAGE_VERSION);
    expect(span.resource.attributes["fancysauce.attribution.environment"]).toBe("prod");
    expect(span.resource.attributes["user.email"]).toBe("ops@example.com");
    expect(span.attributes["fancysauce.attribution.customer"]).toBe("acme");
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
  });

  it("stamps the process defaults on every span, not only on the resource", async () => {
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem });
    sdk.init({
      apiKey: "fs_test_x",
      attribution: { environment: "prod", member: "ops@example.com" },
    });
    const tracer = trace.getTracer("app");
    tracer.startSpan("plain").end();
    sdk.attribute({ environment: "staging" }, () => tracer.startSpan("scoped").end());
    tracer.startSpan("instrumented", { attributes: { "user.email": "caller@example.com" } }).end();
    await sdk.forceFlush();
    const byName = new Map(mem.getFinishedSpans().map((s) => [s.name, s.attributes]));
    expect(byName.get("plain")?.["fancysauce.attribution.environment"]).toBe("prod");
    expect(byName.get("plain")?.["user.email"]).toBe("ops@example.com");
    // An explicit scope key beats the process default.
    expect(byName.get("scoped")?.["fancysauce.attribution.environment"]).toBe("staging");
    expect(byName.get("scoped")?.["user.email"]).toBe("ops@example.com");
    // A reserved attribute the instrumentation set at creation beats it too.
    expect(byName.get("instrumented")?.["user.email"]).toBe("caller@example.com");
  });

  it("warns about a default attribution key it had to drop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    sdk.init({ apiKey: "fs_test_x", attribution: { "Bad Key": "x" } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Bad Key"'));
    warn.mockRestore();
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

  it("installs no context manager when registerContextManager is false", async () => {
    const set = vi.spyOn(context, "setGlobalContextManager");
    const mem = new InMemorySpanExporter();
    sdk = createSdk({ exporterFactory: () => mem });
    sdk.init({ apiKey: "fs_test_x", registerContextManager: false });
    expect(set).not.toHaveBeenCalled();
    const tracer = trace.getTracer("app");
    const parent = tracer.startSpan("parent");
    context.with(trace.setSpan(context.active(), parent), () => {
      tracer.startSpan("child").end();
    });
    parent.end();
    await sdk.forceFlush();
    // Without a manager the no-op one runs the callback but never makes the
    // context active, so the child is a root span.
    expect(
      mem.getFinishedSpans().find((s) => s.name === "child")?.parentSpanContext,
    ).toBeUndefined();
    set.mockRestore();
  });

  it("warns when the context manager cannot be installed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = vi.spyOn(context, "setGlobalContextManager").mockReturnValue(false);
    sdk = createSdk({ exporterFactory: () => new InMemorySpanExporter() });
    sdk.init({ apiKey: "fs_test_x" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("context manager"));
    set.mockRestore();
    warn.mockRestore();
  });

  it("releases the global provider on shutdown so a later init() exports again", async () => {
    const first = new InMemorySpanExporter();
    const second = new InMemorySpanExporter();
    const pool = [first, second];
    sdk = createSdk({ exporterFactory: () => pool.shift()! });
    sdk.init({ apiKey: "fs_test_x" });
    trace.getTracer("app").startSpan("one").end();
    await sdk.forceFlush();
    // Read before shutdown: InMemorySpanExporter drops what it collected there.
    expect(first.getFinishedSpans().map((s) => s.name)).toEqual(["one"]);
    await sdk.shutdown();
    sdk.init({ apiKey: "fs_test_x" });
    trace.getTracer("app").startSpan("two").end();
    await sdk.forceFlush();
    expect(second.getFinishedSpans().map((s) => s.name)).toEqual(["two"]);
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

  it("resolves instrument.ready() only once the class patch has landed", async () => {
    let land = (): void => undefined;
    const patched = new Promise<void>((resolve) => (land = resolve));
    sdk = createSdk({
      exporterFactory: () => new InMemorySpanExporter(),
      instrumentPatch: async () => {
        await patched;
        return true;
      },
    });
    // There is no registry until a client is instrumented, and awaiting the
    // guarantee before then still has to be safe.
    await expect(sdk.instrument.ready()).resolves.toBeUndefined();
    sdk.init({ apiKey: "fs_test_x" });
    sdk.instrument({ messages: { create: (): undefined => undefined } });
    const order: string[] = [];
    const ready = sdk.instrument.ready().then(() => order.push("ready"));
    // setImmediate drains the microtask queue, so an empty log here means the
    // pending patch — not a missed tick — is what ready() is waiting on.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    land();
    await ready;
    expect(order).toEqual(["ready"]);
  });

  it("awaits the new registry's pending patch after a shutdown()+init() cycle, not the old one", async () => {
    let landFirst = (): void => undefined;
    const firstPatched = new Promise<void>((resolve) => (landFirst = resolve));
    let landSecond = (): void => undefined;
    const secondPatched = new Promise<void>((resolve) => (landSecond = resolve));
    const patches = [firstPatched, secondPatched];
    sdk = createSdk({
      exporterFactory: () => new InMemorySpanExporter(),
      instrumentPatch: async () => {
        await patches.shift();
        return true;
      },
    });

    sdk.init({ apiKey: "fs_test_x" });
    sdk.instrument({ messages: { create: (): undefined => undefined } });
    landFirst();
    await sdk.instrument.ready();

    // shutdown() drops the registry; the next instrument() call builds a new
    // one with its own pending patch.
    await sdk.shutdown();
    sdk.init({ apiKey: "fs_test_x" });
    sdk.instrument({ messages: { create: (): undefined => undefined } });

    const order: string[] = [];
    const ready = sdk.instrument.ready().then(() => order.push("ready"));
    // If ready() still pointed at the old (already-settled) registry, this
    // would resolve here instead of waiting on the new registry's patch.
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    landSecond();
    await ready;
    expect(order).toEqual(["ready"]);
  });
});
