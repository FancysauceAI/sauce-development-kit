import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AttributionContext, type Scope } from "../attribution/context.js";
import { resetDiagnostics } from "../diagnostics.js";
import { InstrumentRegistry, type ClassPatch } from "./registry.js";

interface Call {
  body: unknown;
  options: unknown;
  scope: Scope;
  self: unknown;
}

/**
 * An OpenAI-shaped client: the method lives on a prototype, which is where the
 * class patch would land and what the instance wrap has to keep reachable.
 */
function fakeOpenAI(ctx: AttributionContext, calls: Call[]) {
  class Completions {
    create(body: unknown, options?: unknown): Promise<string> {
      calls.push({ body, options, scope: ctx.current(), self: this });
      return Promise.resolve("ok");
    }
  }
  class Chat {
    completions = new Completions();
  }
  class OpenAIish {
    static Chat = Chat;
    chat = new Chat();
  }
  return { OpenAIish, Completions };
}

describe("InstrumentRegistry", () => {
  let ctx: AttributionContext;
  let calls: Call[];
  let patch: Mock<ClassPatch>;

  beforeEach(() => {
    ctx = new AttributionContext({ mode: "auto" });
    calls = [];
    patch = vi.fn<ClassPatch>(() => Promise.resolve(true));
    resetDiagnostics();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnostics();
  });

  const registry = (): InstrumentRegistry =>
    new InstrumentRegistry(ctx, { patch, traceContent: true });

  it("applies the client's attribution to every call made on it", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = new OpenAIish();
    expect(registry().instrument(client, { attribution: { customer: "acme" } })).toBe(client);
    await client.chat.completions.create({ model: "m" });
    expect(calls).toHaveLength(1);
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
    expect(calls[0].self).toBe(client.chat.completions);
  });

  it("merges a per-call override over the client's defaults and the enclosing scope", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish(), {
      attribution: { customer: "acme", feature: "chat" },
    });
    await ctx.attribute({ environment: "prod" }, () =>
      client.chat.completions.create({ model: "m", fancysauce: { customer: "beta" } }),
    );
    expect(calls[0].scope.attribution).toEqual({
      environment: "prod",
      customer: "beta",
      feature: "chat",
    });
  });

  it("strips the fancysauce option so the provider SDK never sees it", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish());
    await client.chat.completions.create({ model: "m", fancysauce: { customer: "acme" } });
    expect(calls[0].body).toEqual({ model: "m" });
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
  });

  it("strips the fancysauce option from the request options too", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish());
    await client.chat.completions.create(
      { model: "m" },
      { timeout: 5, fancysauce: { customer: "acme" } },
    );
    expect(calls[0].body).toEqual({ model: "m" });
    expect(calls[0].options).toEqual({ timeout: 5 });
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
  });

  it("strips the fancysauce option from every argument that carries one", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish());
    await client.chat.completions.create(
      { model: "m", fancysauce: { customer: "acme" } },
      { timeout: 5, fancysauce: { customer: "beta", feature: "chat" } },
    );
    expect(calls[0].body).toEqual({ model: "m" });
    expect(calls[0].options).toEqual({ timeout: 5 });
    // The body is the specific request, so it wins the key both name.
    expect(calls[0].scope.attribution).toEqual({ customer: "acme", feature: "chat" });
  });

  it("leaves the scope empty when nothing was attributed", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish());
    await client.chat.completions.create({ model: "m" });
    expect(calls[0].scope.attribution).toEqual({});
    expect(calls[0].body).toEqual({ model: "m" });
  });

  it("patches the class once, however many instances are instrumented", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const reg = registry();
    reg.instrument(new OpenAIish());
    reg.instrument(new OpenAIish());
    await reg.ready();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe("openai");
    expect(patch.mock.calls[0][1]).toBe(OpenAIish);
    expect(patch.mock.calls[0][2].traceContent).toBe(true);
  });

  it("calls the method the class patch installed, even when the patch lands later", async () => {
    const { OpenAIish, Completions } = fakeOpenAI(ctx, calls);
    const patched: string[] = [];
    const reg = new InstrumentRegistry(ctx, {
      traceContent: false,
      patch: async () => {
        await Promise.resolve();
        // Stands in for a prototype patch, which takes the method value and
        // re-applies it with the caller's `this`, exactly as here.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = Completions.prototype.create;
        Completions.prototype.create = function (body: unknown, options?: unknown) {
          patched.push("span");
          return original.call(this, body, options);
        };
        return true;
      },
    });
    const client = reg.instrument(new OpenAIish(), { attribution: { customer: "acme" } });
    await reg.ready();
    await client.chat.completions.create({ model: "m" });
    // The instance wrap resolves the prototype method per call; capturing it at
    // instrument() time would pin the client to the unpatched one forever.
    expect(patched).toEqual(["span"]);
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
  });

  it("refuses a client it does not recognize, and names what it supports", () => {
    expect(() => registry().instrument({ query: () => undefined })).toThrow(
      /unsupported client.*openai.*anthropic/s,
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("wraps an Anthropic client's messages methods", async () => {
    const seen: Scope[] = [];
    class Messages {
      create(): Promise<string> {
        seen.push(ctx.current());
        return Promise.resolve("ok");
      }
      stream(): Promise<string> {
        seen.push(ctx.current());
        return Promise.resolve("ok");
      }
    }
    class Anthropicish {
      messages = new Messages();
    }
    const reg = registry();
    const client = reg.instrument(new Anthropicish(), { attribution: { customer: "acme" } });
    await client.messages.create();
    await client.messages.stream();
    await reg.ready();
    expect(seen.map((s) => s.attribution)).toEqual([{ customer: "acme" }, { customer: "acme" }]);
    expect(patch.mock.calls[0][0]).toBe("anthropic");
  });

  it("reports a patch that could not run and keeps the client usable", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const reg = new InstrumentRegistry(ctx, {
      traceContent: true,
      patch: () => Promise.resolve(false),
    });
    const client = reg.instrument(new OpenAIish(), { attribution: { customer: "acme" } });
    await expect(reg.ready()).resolves.toBeUndefined();
    await client.chat.completions.create({ model: "m" });
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
  });

  it("replaces the attribution when the same client is instrumented again", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const reg = registry();
    const client = new OpenAIish();
    reg.instrument(client, { attribution: { customer: "a", feature: "chat" } });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared, never called
    const wrapper = client.chat.completions.create;
    reg.instrument(client, { attribution: { customer: "b" } });
    // The same wrapper, carrying the new options: a second wrapper would stack
    // a scope per instrument() call and leak the options of every earlier one.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared, never called
    expect(client.chat.completions.create).toBe(wrapper);
    await client.chat.completions.create({ model: "m" });
    expect(calls[0].scope.attribution).toEqual({ customer: "b" });
  });

  it("repoints the wrapper at the context of the registry that instrumented it last", async () => {
    // What a shutdown() and a second init() produce: a new context, a new
    // registry, and the wrapper the first one installed still on the client.
    // The fake reads the new context, which is the one the live processors and
    // exporter are behind — a wrapper still opening its scope on the retired
    // one leaves this call unattributed there.
    const next = new AttributionContext({ mode: "auto" });
    const { OpenAIish } = fakeOpenAI(next, calls);
    const client = new OpenAIish();
    registry().instrument(client, { attribution: { customer: "a" } });
    new InstrumentRegistry(next, { patch, traceContent: true }).instrument(client, {
      attribution: { customer: "b" },
    });
    await next.attribute({ product: "p" }, () => client.chat.completions.create({ model: "m" }));
    expect(calls[0].scope.attribution).toEqual({ product: "p", customer: "b" });
  });

  it("re-wraps rather than writing into a tag another SDK copy left behind", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = new OpenAIish();
    const target = client.chat.completions as unknown as Record<string, unknown>;
    const foreign = target.create as (...args: unknown[]) => unknown;
    // A wrapper from a copy of the SDK that writes the shared symbol to a
    // contract this one does not know. Its cell must come back untouched.
    const cell = { version: 99, mystery: true };
    Object.defineProperty(target, "create", {
      configurable: true,
      writable: true,
      value: Object.assign(
        function (this: unknown, ...args: unknown[]): unknown {
          return foreign.apply(this, args);
        },
        { [Symbol.for("fancysauce.instrumented")]: cell },
      ),
    });
    registry().instrument(client, { attribution: { customer: "acme" } });
    await client.chat.completions.create({ model: "m" });
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
    expect(cell).toEqual({ version: 99, mystery: true });
  });

  it("warns once and ignores a per-call fancysauce option that is not an object", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const client = registry().instrument(new OpenAIish(), { attribution: { customer: "acme" } });
    await client.chat.completions.create({ model: "m", fancysauce: "beta" });
    await client.chat.completions.create({ model: "m", fancysauce: ["beta"] });
    // Ignored, but still stripped: the provider SDK must never see the field.
    expect(calls.map((c) => c.body)).toEqual([{ model: "m" }, { model: "m" }]);
    expect(calls[0].scope.attribution).toEqual({ customer: "acme" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/fancysauce option must be an object/);
  });

  it("retries the class patch when an earlier attempt did not take", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const attempts = vi
      .fn<ClassPatch>(() => Promise.resolve(true))
      .mockRejectedValueOnce(new Error("import blew up"))
      .mockResolvedValueOnce(false);
    const reg = new InstrumentRegistry(ctx, { traceContent: true, patch: attempts });
    for (let i = 0; i < 3; i++) {
      reg.instrument(new OpenAIish());
      await reg.ready();
    }
    expect(attempts).toHaveBeenCalledTimes(3);
    // The third attempt succeeded, so the class is remembered from then on.
    reg.instrument(new OpenAIish());
    await reg.ready();
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it("does not let a failing patch reject ready() or the call", async () => {
    const { OpenAIish } = fakeOpenAI(ctx, calls);
    const reg = new InstrumentRegistry(ctx, {
      traceContent: true,
      patch: () => Promise.reject(new Error("import blew up")),
    });
    const client = reg.instrument(new OpenAIish());
    await expect(reg.ready()).resolves.toBeUndefined();
    await expect(client.chat.completions.create({ model: "m" })).resolves.toBe("ok");
  });
});
