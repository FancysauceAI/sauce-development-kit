// The SDK's whole voice. A telemetry library that talks over its host is worse
// than one that stays quiet, so every problem is reported once and nothing
// routine is reported at all unless debugging is turned on.

const warned = new Set<string>();
let debugEnabled = false;

export function setDebug(on: boolean): void {
  debugEnabled = on;
}

/** Reports a problem the first time its `key` is seen and never again. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[fancysauce] ${message}`);
}

export function debug(message: string, data?: unknown): void {
  if (debugEnabled) console.debug(`[fancysauce] ${message}`, data ?? "");
}

/** Test hook. */
export function resetDiagnostics(): void {
  warned.clear();
  debugEnabled = false;
}
