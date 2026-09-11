import type { TracerProvider } from "@opentelemetry/api";

/**
 * What a class patch needs from the SDK: where its spans go, and whether the
 * instrumentation records prompts and responses onto them. Shared by every
 * provider under this directory, so it lives here rather than in whichever one
 * declared it first.
 */
export interface PatchOptions {
  tracerProvider: TracerProvider;
  traceContent: boolean;
  /**
   * Records the instrumentation scope whose spans the SDK exports.
   *
   * Called before the class is patched, because the first span can be created
   * the instant it is — a scope recorded even one microtask later would have
   * the filter ahead of the export queue drop that span. And called with the
   * name read off the instrumentation instance, because a literal here would
   * be a second place to change when the package renames itself, and the two
   * disagreeing means every span silently dropped.
   */
  allowScope: (scope: string) => void;
}
