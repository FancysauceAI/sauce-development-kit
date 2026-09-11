/* eslint-disable @typescript-eslint/require-await -- the callbacks below are
   deliberately async with nothing to await: what is under test is that
   attribute() handles a promise-returning callback at all. */
import { beforeEach, describe, expect, it } from "vitest";
import { resetDiagnostics } from "../diagnostics.js";
import { AttributionContext } from "./context.js";

function captureWarnings(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (message: string) => {
    warns.push(message);
  };
  return { warns, restore: () => (console.warn = orig) };
}

describe("AttributionContext (auto mode)", () => {
  let ctx: AttributionContext;
  beforeEach(() => {
    resetDiagnostics();
    ctx = new AttributionContext({ mode: "auto" });
  });

  it("closure form scopes the bag to the callback and its awaits", async () => {
    let inside: Record<string, string> = {};
    await ctx.attribute({ customer: "acme" }, async () => {
      await Promise.resolve();
      inside = ctx.current().attribution;
    });
    expect(inside).toEqual({ customer: "acme" });
    expect(ctx.current().attribution).toEqual({});
  });

  it("nested scopes merge per key, inner wins", async () => {
    await ctx.attribute({ customer: "acme", product: "chat" }, async () => {
      await ctx.attribute({ product: "onboarding" }, async () => {
        expect(ctx.current().attribution).toEqual({ customer: "acme", product: "onboarding" });
      });
      expect(ctx.current().attribution.product).toBe("chat");
    });
  });

  it("carries metadata as a separate bag and reserved keys aside", async () => {
    await ctx.attribute(
      { customer: "acme", conversation: "c1" },
      { metadata: { ticket: "ZD-1" } },
      async () => {
        const s = ctx.current();
        expect(s.metadata).toEqual({ ticket: "ZD-1" });
        expect(s.reserved["gen_ai.conversation.id"]).toBe("c1");
        expect(s.attribution).toEqual({ customer: "acme" });
      },
    );
  });

  it("supports a synchronous callback and returns its value", () => {
    expect(ctx.attribute({ a: "1" }, () => ctx.current().attribution.a)).toBe("1");
    expect(ctx.current().attribution).toEqual({});
  });

  it("returns the async callback's value and propagates its error", async () => {
    await expect(ctx.attribute({ a: "1" }, async () => 42)).resolves.toBe(42);
    await expect(
      ctx.attribute({ a: "1" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("start / add / end operate on the current async flow", () => {
    ctx.attribute.start({ customer: "acme" });
    expect(ctx.current().attribution).toEqual({ customer: "acme" });
    ctx.attribute.add({ feature: "summarize" });
    expect(ctx.current().attribution).toEqual({ customer: "acme", feature: "summarize" });
    ctx.attribute.end("feature");
    expect(ctx.current().attribution).toEqual({ customer: "acme" });
    ctx.attribute.end();
    expect(ctx.current().attribution).toEqual({});
  });

  it("concurrent flows do not leak into each other", async () => {
    const seen: string[] = [];
    await Promise.all([
      ctx.attribute({ customer: "a" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(ctx.current().attribution.customer);
      }),
      ctx.attribute({ customer: "b" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(ctx.current().attribution.customer);
      }),
    ]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("warns once per dropped key", async () => {
    const { warns, restore } = captureWarnings();
    try {
      await ctx.attribute({ "Bad Key": "x" }, async () => {});
      await ctx.attribute({ "Bad Key": "y" }, async () => {});
    } finally {
      restore();
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/bad key/i);
  });
});

describe("AttributionContext (global mode)", () => {
  beforeEach(() => {
    resetDiagnostics();
  });

  it("uses one process-wide bag and never warns", async () => {
    const { warns, restore } = captureWarnings();
    try {
      const ctx = new AttributionContext({ mode: "global" });
      ctx.attribute.start({ customer: "acme" });
      await Promise.resolve();
      expect(ctx.current().attribution).toEqual({ customer: "acme" });
      await ctx.attribute({ product: "p" }, async () => {
        expect(ctx.current().attribution).toEqual({ customer: "acme", product: "p" });
      });
      expect(ctx.current().attribution).toEqual({ customer: "acme" });
      ctx.attribute.end();
      expect(ctx.current().attribution).toEqual({});
    } finally {
      restore();
    }
    expect(warns).toEqual([]);
  });
});
