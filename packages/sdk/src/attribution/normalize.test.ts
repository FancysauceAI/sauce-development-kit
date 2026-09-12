import { describe, expect, it } from "vitest";
import { expandReserved, normalizeBag, normalizeMetadata, type BagInput } from "./normalize.js";

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
  it("drops underscored keys, which the category registry does not accept", () => {
    const r = normalizeBag({ cost_center: "x", "cost-center": "y" });
    expect(r.attribution).toEqual({ "cost-center": "y" });
    expect(r.dropped).toEqual([
      { key: "cost_center", rawKey: "cost_center", reason: "invalid-key" },
    ]);
  });
  it("reports a key the prototype would otherwise swallow", () => {
    const r = normalizeBag(JSON.parse('{"__proto__":"x","customer":"acme"}') as BagInput);
    expect(r.attribution).toEqual({ customer: "acme" });
    expect(Object.getPrototypeOf(r.attribution)).toBe(null);
    expect(r.dropped).toEqual([{ key: "__proto__", rawKey: "__proto__", reason: "invalid-key" }]);
  });
  it("keeps an inherited member name as the caller's own data", () => {
    const r = normalizeBag({ constructor: "acme" });
    expect(r.attribution["constructor"]).toBe("acme");
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
  it("keeps reserved keys out of the attribution bag, as the caller wrote them", () => {
    const r = normalizeBag({
      member: "Dev@Example.com",
      conversation: "conv_1",
      customer: "acme",
    });
    expect(r.attribution).toEqual({ customer: "acme" });
    expect(r.reserved).toEqual({ member: "Dev@Example.com", conversation: "conv_1" });
  });
  it("expands reserved keys into the standard attributes they map to", () => {
    expect(expandReserved({ member: "Dev@Example.com", conversation: "conv_1" })).toEqual({
      "user.email": "dev@example.com",
      "gen_ai.conversation.id": "conv_1",
      "session.id": "conv_1",
    });
  });
  it("expands a non-email member to user.id", () => {
    expect(expandReserved({ member: "u_9" })).toEqual({ "user.id": "u_9" });
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
  it("coerces numbers, booleans, and bigints to strings", () => {
    expect(normalizeBag({ tier: 3, beta: true, seq: 9007199254740993n }).attribution).toEqual({
      tier: "3",
      beta: "true",
      seq: "9007199254740993",
    });
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
