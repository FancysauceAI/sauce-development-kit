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
  it("normalizes underscores to hyphens, same as lowercasing", () => {
    const r = normalizeBag({ Cost_Center: "x" });
    expect(r.attribution).toEqual({ "cost-center": "x" });
    expect(r.dropped).toEqual([]);
  });
  it("normalizes a key that is underscore-normalized into a duplicate", () => {
    const r = normalizeBag({ cost_center: "first", "cost-center": "second" });
    expect(r.attribution).toEqual({ "cost-center": "first" });
    expect(r.dropped).toEqual([
      { key: "cost-center", rawKey: "cost-center", reason: "duplicate-key" },
    ]);
  });
  it("normalizes runs of underscores to runs of hyphens", () => {
    const r = normalizeBag({ a__b: "x" });
    expect(r.attribution).toEqual({ "a--b": "x" });
    expect(r.dropped).toEqual([]);
  });
  it("still drops a key that is invalid after underscore normalization: underscore-only over the length cap, and a plain over-length key", () => {
    const underscoreOnly = "_".repeat(41);
    const overLength = "a".repeat(41);
    const r = normalizeBag({ [underscoreOnly]: "x", [overLength]: "y" });
    expect(r.attribution).toEqual({});
    expect(r.dropped).toEqual([
      { key: "-".repeat(41), rawKey: underscoreOnly, reason: "invalid-key" },
      { key: overLength, rawKey: overLength, reason: "invalid-key" },
    ]);
  });
  it("normalizes __proto__ into a valid key kept as caller data", () => {
    const r = normalizeBag(JSON.parse('{"__proto__":"x","customer":"acme"}') as BagInput);
    expect(Object.getPrototypeOf(r.attribution)).toBe(null);
    expect(r.attribution["--proto--"]).toBe("x");
    expect(r.attribution["customer"]).toBe("acme");
    expect(r.dropped).toEqual([]);
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
  it("still recognizes reserved keys after normalization, which contain no underscores to map", () => {
    const r = normalizeBag({ Member: "Dev@Example.com", Conversation: "conv_1" });
    expect(r.attribution).toEqual({});
    expect(r.reserved).toEqual({ member: "Dev@Example.com", conversation: "conv_1" });
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
