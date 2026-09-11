// The SDK's whole voice. A telemetry library that talks over its host is worse
// than one that stays quiet, so every problem is reported once and nothing
// routine is reported at all unless debugging is turned on.

// The dedupe set is also the budget. A caller generating keys from unbounded
// input (a request id, a customer name) would otherwise grow the set for the
// life of the process and narrate every one of them.
const WARN_LIMIT = 64;
const warned = new Set<string>();
let suppressed = false;
let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

/**
 * Reports a problem the first time its `key` is seen and never again. After
 * WARN_LIMIT distinct keys, says so once and goes quiet for good.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  if (warned.size >= WARN_LIMIT) {
    if (suppressed) return;
    suppressed = true;
    console.warn("[fancysauce] further attribution warnings suppressed");
    return;
  }
  warned.add(key);
  console.warn(`[fancysauce] ${message}`);
}

export function debug(message: string, data?: unknown): void {
  if (debugEnabled) console.debug(`[fancysauce] ${message}`, data ?? "");
}

/** Test hook. */
export function resetDiagnostics(): void {
  warned.clear();
  suppressed = false;
  debugEnabled = false;
}
