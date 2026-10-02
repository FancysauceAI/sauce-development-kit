import { trace, type Tracer } from "@opentelemetry/api";
import type { ContentMode } from "./export/content-policy-exporter.js";

/**
 * What the Vercel AI SDK reads from its telemetry option — `isEnabled`,
 * `recordInputs`, `recordOutputs` and (in v4/v5) `tracer`, the names its own
 * type uses. Declared structurally rather than imported from `ai`, so this
 * package neither depends on the AI SDK at runtime nor pins a version of it;
 * `vercel.types.test.ts` checks the shape against the AI SDK's own type at
 * compile time.
 *
 * The extra fields those types offer — `functionId`, `metadata` — are the
 * caller's to add by spreading this: `{ ...fancy.vercelTelemetry(), functionId }`.
 */
export interface VercelTelemetry {
  isEnabled: true;
  tracer: Tracer;
  recordInputs: boolean;
  recordOutputs: boolean;
}

/**
 * The scope AI SDK 4 and 5 spans carry, because those versions span against
 * the tracer they are handed. Named rather than left to the AI SDK's default
 * so the spans are attributable to this package — and exported here because
 * the scope filter's allow-list has to name it too.
 */
export const VERCEL_TRACER_NAME = "@fancysauce/sdk/vercel-ai";

/**
 * The tracer is resolved per call: the global provider `init()` registers may
 * not exist yet when a module builds its options at import time.
 */
export function buildVercelTelemetry(opts: { content: ContentMode }): VercelTelemetry {
  const record = opts.content === "full";
  return {
    isEnabled: true,
    tracer: trace.getTracer(VERCEL_TRACER_NAME),
    recordInputs: record,
    recordOutputs: record,
  };
}
