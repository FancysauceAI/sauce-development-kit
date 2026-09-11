import {
  KEY_PATTERN,
  REFUSED_KEY_PREFIXES,
  RESERVED_KEYS,
  VALUE_MAX_LENGTH,
  type ReservedKey,
} from "../contract.js";

export type BagInput = Record<string, string | number | boolean | null | undefined>;

export type DropReason =
  "invalid-key" | "refused-prefix" | "empty-value" | "invalid-value" | "duplicate-key";

export interface DroppedKey {
  /** The normalized form the key would have taken. */
  key: string;
  /** The key exactly as the caller wrote it, so a warning can quote it back. */
  rawKey: string;
  reason: DropReason;
}

export interface NormalizedBag {
  attribution: Record<string, string>;
  /** Standard attributes produced by reserved keys (user.email, gen_ai.conversation.id, …). */
  reserved: Record<string, string>;
  dropped: DroppedKey[];
}

export interface NormalizedMetadata {
  metadata: Record<string, string>;
  dropped: DroppedKey[];
}

interface Normalized {
  kept: Record<string, string>;
  reserved: Record<string, string>;
  dropped: DroppedKey[];
}

function isReserved(key: string): key is ReservedKey {
  return Object.prototype.hasOwnProperty.call(RESERVED_KEYS, key);
}

// A trimmed string for anything that can be written on the wire, `null` for
// anything that cannot. `null` and `undefined` become the empty string so they
// are reported as an empty value rather than as a type the caller never wrote.
function toValue(raw: unknown): string | null {
  if (raw == null) return "";
  switch (typeof raw) {
    case "string":
      return raw.trim();
    case "boolean":
    case "bigint":
      return String(raw);
    case "number":
      return Number.isFinite(raw) ? String(raw) : null;
    default:
      return null;
  }
}

// Shared key/value hygiene; `mapReserved` decides whether reserved keys are
// lifted to standard attributes (the attribution bag) or kept as plain keys
// (metadata). Every rejected key is reported with its reason — silence here is
// what turns a typo into a month of missing attribution.
function normalize(input: BagInput, mapReserved: boolean): Normalized {
  // Prototype-less so a key like `__proto__` is stored and reported as data
  // rather than mutating the accumulator.
  const out: Normalized = {
    kept: Object.create(null) as Record<string, string>,
    reserved: Object.create(null) as Record<string, string>,
    dropped: [],
  };
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase();
    const drop = (reason: DropReason): void => void out.dropped.push({ key, rawKey, reason });

    if (REFUSED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      drop("refused-prefix");
      continue;
    }
    if (!KEY_PATTERN.test(key)) {
      drop("invalid-key");
      continue;
    }
    const value = toValue(rawValue);
    if (value === null) {
      drop("invalid-value");
      continue;
    }
    if (value === "") {
      drop("empty-value");
      continue;
    }
    if (seen.has(key)) {
      drop("duplicate-key");
      continue;
    }
    if (mapReserved && isReserved(key)) {
      // Reserved values are identity join keys, classified on the untruncated
      // value: a half an email address matches the wrong person, so an
      // over-long one is refused outright.
      if (value.length > VALUE_MAX_LENGTH) {
        drop("invalid-value");
        continue;
      }
      seen.add(key);
      Object.assign(out.reserved, RESERVED_KEYS[key].toAttributes(value));
      continue;
    }
    seen.add(key);
    out.kept[key] = value.slice(0, VALUE_MAX_LENGTH);
  }
  return out;
}

export function normalizeBag(input: BagInput): NormalizedBag {
  const n = normalize(input, true);
  return { attribution: n.kept, reserved: n.reserved, dropped: n.dropped };
}

export function normalizeMetadata(input: BagInput): NormalizedMetadata {
  const n = normalize(input, false);
  return { metadata: n.kept, dropped: n.dropped };
}
