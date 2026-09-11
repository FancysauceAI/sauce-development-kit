import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect } from "vitest";

/**
 * The fields the tracer mints fresh on every run — no two runs ever agree on
 * these, so the compare has to blank them on both sides before it means
 * anything.
 */
const PER_RUN_FIELDS = new Set([
  "traceId",
  "spanId",
  "parentSpanId",
  "startTimeUnixNano",
  "endTimeUnixNano",
]);

/**
 * Attributes whose value tracks the package rather than the wire shape. Left
 * alone, the first version bump would fail both contract suites over a change
 * they exist to be indifferent to.
 */
const PER_RUN_ATTRIBUTES = new Set(["fancysauce.sdk.version"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const { key } = value as { key?: unknown };
    if (typeof key === "string" && PER_RUN_ATTRIBUTES.has(key))
      return { key, value: "<normalized>" };
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        PER_RUN_FIELDS.has(k) ? "<normalized>" : normalize(v),
      ]),
    );
  }
  return value;
}

/**
 * Recording the fixture is a side effect the ingest depends on; comparing
 * against it is the assertion — the two were previously conflated into an
 * unconditional write, which made the suite pass even when the wire shape
 * regressed. Set RECORD_CONTRACT=1 (or delete the file) to re-record, which
 * is required whenever bumping a `@traceloop/instrumentation-*` package
 * changes the recorded `scope.version` — that is expected to fail the
 * compare until re-recorded, not a bug in this helper.
 */
export function recordOrCompare(file: string, body: unknown): void {
  if (process.env.RECORD_CONTRACT === "1" || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    return;
  }
  const recorded: unknown = JSON.parse(readFileSync(file, "utf8"));
  expect(normalize(body)).toEqual(normalize(recorded));
}
