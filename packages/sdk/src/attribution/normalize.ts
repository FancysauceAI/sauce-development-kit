import {
  KEY_PATTERN,
  REFUSED_KEY_PREFIXES,
  RESERVED_KEYS,
  VALUE_MAX_LENGTH,
  type ReservedKey,
} from "../contract.js";

export type BagInput = Record<string, string | number | boolean | null | undefined>;

export interface NormalizedBag {
  attribution: Record<string, string>;
  /** Standard attributes produced by reserved keys (user.email, gen_ai.conversation.id, …). */
  reserved: Record<string, string>;
  dropped: Array<{ key: string; reason: "invalid-key" | "empty-value" }>;
}

function isReserved(key: string): key is ReservedKey {
  return Object.prototype.hasOwnProperty.call(RESERVED_KEYS, key);
}

// Shared key/value hygiene; `mapReserved` decides whether reserved keys are
// lifted to standard attributes (the attribution bag) or kept as plain keys
// (metadata).
function normalize(input: BagInput, mapReserved: boolean): NormalizedBag {
  const out: NormalizedBag = { attribution: {}, reserved: {}, dropped: [] };
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue == null ? "" : String(rawValue).trim();
    if (!KEY_PATTERN.test(key) || REFUSED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      out.dropped.push({ key, reason: "invalid-key" });
      continue;
    }
    if (value === "") {
      out.dropped.push({ key, reason: "empty-value" });
      continue;
    }
    const capped = value.slice(0, VALUE_MAX_LENGTH);
    if (mapReserved && isReserved(key))
      Object.assign(out.reserved, RESERVED_KEYS[key].toAttributes(capped));
    else out.attribution[key] = capped;
  }
  return out;
}

export function normalizeBag(input: BagInput): NormalizedBag {
  return normalize(input, true);
}

export function normalizeMetadata(input: BagInput): {
  metadata: Record<string, string>;
  dropped: NormalizedBag["dropped"];
} {
  const n = normalize(input, false);
  return { metadata: n.attribution, dropped: n.dropped };
}
