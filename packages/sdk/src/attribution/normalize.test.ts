import { describe, expect, it } from "vitest";
import { normalizeBag, normalizeMetadata } from "./normalize.js";

describe("normalizeBag", () => {
  it("lowercases and trims keys and trims values", () => {
    const r = normalizeBag({ " Customer ": " acme-42 " });
    expect(r.attribution).toEqual({ customer: "acme-42" });
    expect(r.dropped).toEqual([]);
  });
  it("drops keys that are not registry slugs and reports them", () => {
    const r = normalizeBag({ "Customer Name": "x", "gen_ai.system": "y", "": "z" });
    expect(r.attribution).toEqual({});
    expect(r.dropped.map((d) => d.key)).toEqual(["customer name", "gen_ai.system", ""]);
  });
  it("drops empty values and caps long values at 200 chars", () => {
    const r = normalizeBag({ a: "", b: "x".repeat(300) });
    expect(r.attribution).toEqual({ b: "x".repeat(200) });
    expect(r.dropped.map((d) => d.key)).toEqual(["a"]);
  });
  it("maps reserved keys to standard attributes instead of the bag", () => {
    const r = normalizeBag({
      member: "Sean@Example.com",
      conversation: "conv_1",
      customer: "acme",
    });
    expect(r.attribution).toEqual({ customer: "acme" });
    expect(r.reserved).toEqual({
      "user.email": "sean@example.com",
      "gen_ai.conversation.id": "conv_1",
      "session.id": "conv_1",
    });
  });
  it("maps a non-email member to user.id", () => {
    expect(normalizeBag({ member: "u_9" }).reserved).toEqual({ "user.id": "u_9" });
  });
  it("coerces numbers and booleans to strings", () => {
    expect(normalizeBag({ tier: 3, beta: true }).attribution).toEqual({ tier: "3", beta: "true" });
  });
});

describe("normalizeMetadata", () => {
  it("applies the same key rule and cap but never maps reserved keys", () => {
    const r = normalizeMetadata({ Ticket: " ZD-1 ", member: "someone", "bad key": "x" });
    expect(r.metadata).toEqual({ ticket: "ZD-1", member: "someone" });
    expect(r.dropped.map((d) => d.key)).toEqual(["bad key"]);
  });
});
