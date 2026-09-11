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
}
