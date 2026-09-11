import { trace, type Tracer } from "@opentelemetry/api";
import type { ContentMode } from "./export/content-policy-exporter.js";

/**
 * What the Vercel AI SDK reads from its telemetry option — `isEnabled`,
 * `recordInputs`, `recordOutputs` and (in v4/v5) `tracer`, the names its own
 * type uses. Declared structurally rather than imported from `ai`, so this
 * package neither depends on the AI SDK nor pins a version of it: the option
 * is `experimental_telemetry: TelemetrySettings` in v4 and v5 and
 * `telemetry: TelemetryOptions` in v7, and both accept this object.
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
 * Pass as `experimental_telemetry` to Vercel AI SDK calls. Content capture
 * follows `init({ content })`.
 *
 * The tracer is named rather than left to the AI SDK's default so the spans
 * are attributable to this package, and it is resolved per call: the global
 * provider `init()` registers may not exist yet when a module builds its
 * options at import time.
 */
export function vercelTelemetry(opts: { content: ContentMode }): VercelTelemetry {
  const record = opts.content === "full";
  return {
    isEnabled: true,
    tracer: trace.getTracer("@fancysauce/sdk/vercel-ai"),
    recordInputs: record,
    recordOutputs: record,
  };
}
