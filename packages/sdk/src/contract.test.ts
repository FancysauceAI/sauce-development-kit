import { describe, expect, it } from "vitest";
import {
  ATTR,
  CONTENT_ATTRIBUTES,
  KEY_PATTERN,
  RESERVED_KEYS,
  SCHEMA_VERSION,
  SOURCE_TYPE,
  VALUE_MAX_LENGTH,
} from "./contract.js";

describe("contract", () => {
  it("names the source type and schema version the ingest expects", () => {
    expect(SOURCE_TYPE).toBe("fancysauce_sdk");
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });
  it("prefixes attribution and metadata attributes", () => {
    expect(ATTR.attributionPrefix).toBe("fancysauce.attribution.");
    expect(ATTR.metadataPrefix).toBe("fancysauce.metadata.");
  });
  it("lists exactly the three content attributes", () => {
    expect([...CONTENT_ATTRIBUTES]).toEqual([
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
    ]);
  });
  it("reserves exactly member and conversation", () => {
    expect(Object.keys(RESERVED_KEYS).sort()).toEqual(["conversation", "member"]);
  });
  it("maps reserved keys to standard attributes", () => {
    expect(RESERVED_KEYS.member.toAttributes("Sean@Example.com")).toEqual({
      "user.email": "sean@example.com",
    });
    expect(RESERVED_KEYS.member.toAttributes("u_9")).toEqual({ "user.id": "u_9" });
    expect(RESERVED_KEYS.conversation.toAttributes("c1")).toEqual({
      "gen_ai.conversation.id": "c1",
      "session.id": "c1",
    });
  });
  it("key pattern is the registry slug rule", () => {
    expect(KEY_PATTERN.test("customer")).toBe(true);
    expect(KEY_PATTERN.test("cost-center_2")).toBe(true);
    expect(KEY_PATTERN.test("Customer")).toBe(false);
    expect(KEY_PATTERN.test("a".repeat(41))).toBe(false);
    expect(VALUE_MAX_LENGTH).toBe(200);
  });
});
