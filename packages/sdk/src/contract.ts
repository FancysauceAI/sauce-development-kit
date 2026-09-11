// The wire contract between this SDK and the Fancysauce ingest. This module
// has no runtime dependencies so the ingest can pin it directly.

export const SOURCE_TYPE = "fancysauce_sdk" as const;
export const SCHEMA_VERSION = "1.0.0" as const;

export const ATTR = {
  // The two *Prefix entries are concatenated with a bag key
  // (fancysauce.attribution.customer); every other entry is a complete name.
  attributionPrefix: "fancysauce.attribution.",
  metadataPrefix: "fancysauce.metadata.",
  schemaVersion: "fancysauce.schema_version",
  sdkVersion: "fancysauce.sdk.version",
  contentTruncated: "fancysauce.content.truncated",
  // Total UTF-8 bytes of the content attributes as exported, after redaction
  // and truncation. Advisory: the ingest recomputes it from the payload it
  // receives, so it is a cross-check on what arrived, never the source of
  // truth.
  contentBytes: "fancysauce.content.bytes",
  userEmail: "user.email",
  userId: "user.id",
  conversationId: "gen_ai.conversation.id",
  sessionId: "session.id",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  systemInstructions: "gen_ai.system_instructions",
} as const;

export const CONTENT_ATTRIBUTES = [
  ATTR.inputMessages,
  ATTR.outputMessages,
  ATTR.systemInstructions,
] as const;

// Reserved bag keys are mapped to standard attributes and never emitted as
// fancysauce.attribution.* — the server refuses them as category keys.
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const RESERVED_KEYS = {
  member: {
    // Every attribute the key can map to, which is not the same as the ones a
    // given value writes: `member` picks one of these two by value, so a
    // consumer deciding whether the call is already identified has to look at
    // both.
    attributes: [ATTR.userEmail, ATTR.userId],
    toAttributes: (v: string): Record<string, string> =>
      // Lowercasing the whole address (not just the local part) is deliberate:
      // it's a stable join key, and providers ignore local-part case.
      EMAIL_PATTERN.test(v) ? { [ATTR.userEmail]: v.toLowerCase() } : { [ATTR.userId]: v },
  },
  conversation: {
    attributes: [ATTR.conversationId, ATTR.sessionId],
    toAttributes: (v: string): Record<string, string> => ({
      [ATTR.conversationId]: v,
      [ATTR.sessionId]: v,
    }),
  },
} as const;
export type ReservedKey = keyof typeof RESERVED_KEYS;

// Category keys are registry slugs: lowercase, 1–40 chars of [a-z0-9_-].
export const KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

// These prefixes match complete attribute names a caller might try to smuggle
// through a per-call override or metadata bag — never registry slugs, which
// can't contain a dot. The SDK drops any key starting with one before it
// reaches the wire.
export const REFUSED_KEY_PREFIXES = ["fancysauce.", "gen_ai.", "user."] as const;
export const VALUE_MAX_LENGTH = 200;
export const CONTENT_ATTRIBUTE_MAX_BYTES = 256 * 1024;
