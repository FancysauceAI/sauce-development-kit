export type Provider = "openai" | "anthropic";

// Walks a dotted path without ever indexing a non-object, so a client whose
// `chat` is a string is a miss rather than a throw.
const has = (o: unknown, path: string): boolean =>
  path
    .split(".")
    .reduce<unknown>(
      (cur, k) =>
        cur != null && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined,
      o,
    ) !== undefined;

/**
 * Detects the provider from the client instance's surface, not its package.
 * A subclass, a proxy, a client built by a wrapper library and a client from a
 * second copy of the SDK in the tree all answer the same way, and nothing here
 * requires the provider's package to be resolvable from this module.
 */
export function detectProvider(client: unknown): Provider | null {
  if (client == null || typeof client !== "object") return null;
  if (has(client, "chat.completions.create") || has(client, "responses.create")) return "openai";
  if (has(client, "messages.create")) return "anthropic";
  return null;
}
