import { sdk } from "./process-sdk.js";

export type { InitOptions } from "./config.js";
export type { AttributeOptions, ContextMode } from "./attribution/context.js";
export type { BagInput } from "./attribution/normalize.js";
export type { ContentMode } from "./export/content-policy-exporter.js";
export type { InstrumentOptions } from "./instrument/registry.js";
export type { VercelTelemetry } from "./vercel-telemetry.js";
export type { BatchResult, BatchResultUsage } from "./batch/record.js";
export { SCHEMA_VERSION } from "./contract.js";

/**
 * The SDK's whole public surface.
 *
 * `init()` first, once, at startup; `attribute()` around the work you want
 * attributed; `instrument(client)` for an OpenAI or Anthropic client, or
 * `vercelTelemetry()` for the Vercel AI SDK, and `recordBatchResult()` for
 * the results of a provider batch API. `spanProcessors()` is the seam
 * for an application that owns its own tracer provider.
 */
export const fancy = {
  init: sdk.init,
  attribute: sdk.attribute,
  instrument: sdk.instrument,
  recordBatchResult: sdk.recordBatchResult,
  vercelTelemetry: sdk.vercelTelemetry,
  spanProcessors: sdk.spanProcessors,
  forceFlush: sdk.forceFlush,
  shutdown: sdk.shutdown,
};

export type Fancy = typeof fancy;
