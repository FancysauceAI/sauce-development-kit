import { describe, expect, it } from "vitest";
import { normalizeBag, normalizeMetadata, type BagInput } from "./normalize.js";

describe("normalizeBag", () => {
  it("lowercases and trims keys and trims values", () => {
    const r = normalizeBag({ " Customer ": " acme-42 " });
    expect(r.attribution).toEqual({ customer: "acme-42" });
    expect(r.dropped).toEqual([]);
  });
  it("drops keys that are not registry slugs and reports them", () => {
    const r = normalizeBag({ "Customer Name": "x", "": "z" });
    expect(r.attribution).toEqual({});
    expect(r.dropped).toEqual([
      { key: "customer name", rawKey: "Customer Name", reason: "invalid-key" },
      { key: "", rawKey: "", reason: "invalid-key" },
    ]);
  });
  it("refuses keys carrying a reserved attribute prefix before judging their shape", () => {
    const r = normalizeBag({ "user.email": "x", "gen_ai.system": "y", "fancysauce.foo": "z" });
    expect(r.attribution).toEqual({});
    expect(r.dropped.map((d) => d.reason)).toEqual([
      "refused-prefix",
      "refused-prefix",
      "refused-prefix",
    ]);
  });
  it("drops empty values and caps long values at 200 chars", () => {
    const r = normalizeBag({ a: "", b: "x".repeat(300) });
    expect(r.attribution).toEqual({ b: "x".repeat(200) });
    expect(r.dropped).toEqual([{ key: "a", rawKey: "a", reason: "empty-value" }]);
  });
  it("reports a key the prototype would otherwise swallow", () => {
    const r = normalizeBag(JSON.parse('{"__proto__":"x","customer":"acme"}') as BagInput);
    expect(Object.keys(r.attribution).sort()).toEqual(["__proto__", "customer"]);
    expect(r.attribution["__proto__"]).toBe("x");
    expect(r.dropped).toEqual([]);
  });
  it("drops values that are not primitives", () => {
    const cases: Array<[string, unknown]> = [
      ["object", {}],
      ["array", ["a"]],
      ["symbol", Symbol("s")],
      ["function", () => "x"],
      ["nan", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["negative-infinity", Number.NEGATIVE_INFINITY],
    ];
    for (const [label, value] of cases) {
      const r = normalizeBag({ customer: value } as unknown as BagInput);
      expect(r.attribution, label).toEqual({});
      expect(r.dropped, label).toEqual([
        { key: "customer", rawKey: "customer", reason: "invalid-value" },
      ]);
    }
  });
  it("maps reserved keys to standard attributes instead of the bag", () => {
    const r = normalizeBag({
      member: "Dev@Example.com",
      conversation: "conv_1",
      customer: "acme",
    });
    expect(r.attribution).toEqual({ customer: "acme" });
    expect(r.reserved).toEqual({
      "user.email": "dev@example.com",
      "gen_ai.conversation.id": "conv_1",
      "session.id": "conv_1",
    });
  });
  it("maps a non-email member to user.id", () => {
    expect(normalizeBag({ member: "u_9" }).reserved).toEqual({ "user.id": "u_9" });
  });
  it("drops an over-long reserved value rather than truncating a join key", () => {
    const email = "a".repeat(201 - "@example.com".length) + "@example.com";
    expect(email).toHaveLength(201);
    const r = normalizeBag({ member: email });
    expect(r.reserved).toEqual({});
    expect(r.dropped).toEqual([{ key: "member", rawKey: "member", reason: "invalid-value" }]);
  });
  it("keeps the first of two keys that normalize to the same slug", () => {
    const r = normalizeBag({ " Customer ": "first", customer: "second" });
    expect(r.attribution).toEqual({ customer: "first" });
    expect(r.dropped).toEqual([{ key: "customer", rawKey: "customer", reason: "duplicate-key" }]);
  });
  it("coerces numbers and booleans to strings", () => {
    expect(normalizeBag({ tier: 3, beta: true }).attribution).toEqual({ tier: "3", beta: "true" });
  });
});

describe("normalizeMetadata", () => {
  it("applies the same key rule and cap but never maps reserved keys", () => {
    const r = normalizeMetadata({ Ticket: " ZD-1 ", member: "someone", "bad key": "x" });
    expect(r.metadata).toEqual({ ticket: "ZD-1", member: "someone" });
    expect(r.dropped).toEqual([{ key: "bad key", rawKey: "bad key", reason: "invalid-key" }]);
  });
  it("truncates rather than drops an over-long reserved key held as metadata", () => {
    const r = normalizeMetadata({ member: "a".repeat(300) });
    expect(r.metadata).toEqual({ member: "a".repeat(200) });
  });
});
