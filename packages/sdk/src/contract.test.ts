import { describe, expect, it } from "vitest";
import {
  ATTR,
  CONTENT_ATTRIBUTES,
  EMAIL_PATTERN,
  KEY_PATTERN,
  REFUSED_KEY_PREFIXES,
  RESERVED_KEYS,
  SCHEMA_VERSION,
  VALUE_MAX_LENGTH,
} from "./contract.js";

describe("contract", () => {
  it("names the schema version the ingest expects", () => {
    expect(SCHEMA_VERSION).toBe("1.0.1");
  });
  it("prefixes attribution and metadata attributes", () => {
    expect(ATTR.attributionPrefix).toBe("fancysauce.attribution.");
    expect(ATTR.metadataPrefix).toBe("fancysauce.metadata.");
  });
  it("pins every ATTR key so a rename shows up as a diff, not a silent wire break", () => {
    expect(ATTR).toEqual({
      attributionPrefix: "fancysauce.attribution.",
      metadataPrefix: "fancysauce.metadata.",
      schemaVersion: "fancysauce.schema_version",
      sdkVersion: "fancysauce.sdk.version",
      batchId: "fancysauce.batch.id",
      batchCustomId: "fancysauce.batch.custom_id",
      serviceTier: "fancysauce.service_tier",
      contentTruncated: "fancysauce.content.truncated",
      contentBytes: "fancysauce.content.bytes",
      userEmail: "user.email",
      userId: "user.id",
      conversationId: "gen_ai.conversation.id",
      sessionId: "session.id",
      inputMessages: "gen_ai.input.messages",
      outputMessages: "gen_ai.output.messages",
      systemInstructions: "gen_ai.system_instructions",
    });
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
  it("names every attribute a reserved key can map to, not only the one a value writes", () => {
    expect([...RESERVED_KEYS.member.attributes]).toEqual(["user.email", "user.id"]);
    expect([...RESERVED_KEYS.conversation.attributes]).toEqual([
      "gen_ai.conversation.id",
      "session.id",
    ]);
  });
  it("maps reserved keys to standard attributes", () => {
    expect(RESERVED_KEYS.member.toAttributes("Sean@Example.com")).toEqual({
      "user.email": "sean@example.com",
    });
    expect(RESERVED_KEYS.member.toAttributes("u_9")).toEqual({ "user.id": "u_9" });
    expect(RESERVED_KEYS.member.toAttributes("@handle")).toEqual({ "user.id": "@handle" });
    expect(RESERVED_KEYS.conversation.toAttributes("c1")).toEqual({
      "gen_ai.conversation.id": "c1",
      "session.id": "c1",
    });
  });
  it("key pattern is the registry slug rule", () => {
    expect(KEY_PATTERN.test("customer")).toBe(true);
    expect(KEY_PATTERN.test("cost-center-2")).toBe(true);
    expect(KEY_PATTERN.test("cost_center")).toBe(false);
    expect(KEY_PATTERN.test("Customer")).toBe(false);
    expect(KEY_PATTERN.test("a".repeat(41))).toBe(false);
    expect(VALUE_MAX_LENGTH).toBe(200);
  });
  it("pins the refused key prefixes by value", () => {
    expect([...REFUSED_KEY_PREFIXES]).toEqual(["fancysauce.", "gen_ai.", "user."]);
  });
  it("recognizes an address only with a local part, a host, and a dot", () => {
    expect(EMAIL_PATTERN.test("dev@example.com")).toBe(true);
    expect(EMAIL_PATTERN.test("@handle")).toBe(false);
    expect(EMAIL_PATTERN.test("dev@localhost")).toBe(false);
  });
});
