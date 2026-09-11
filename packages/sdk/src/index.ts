import { createSdk } from "./init.js";
import { vercelTelemetry as makeVercelTelemetry } from "./vercel.js";

export type { InitOptions } from "./config.js";
export type { AttributeOptions, Scope } from "./attribution/context.js";
export type { BagInput } from "./attribution/normalize.js";
export type { InstrumentOptions } from "./instrument/registry.js";
export type { VercelTelemetry } from "./vercel.js";
export { SCHEMA_VERSION } from "./contract.js";

// One SDK per process, because what it owns — the global tracer provider, the
// context manager, the attribution scope — is process-wide. Tests that need a
// second one construct it through the internal factory.
const sdk = createSdk();

/**
 * The SDK's whole public surface.
 *
 * `init()` first, once, at startup; `attribute()` around the work you want
 * attributed; `instrument(client)` for an OpenAI or Anthropic client, or
 * `vercelTelemetry()` for the Vercel AI SDK. `spanProcessors()` is the seam
 * for an application that owns its own tracer provider.
 */
export const fancy = {
  init: sdk.init,
  attribute: sdk.attribute,
  instrument: sdk.instrument,
  vercelTelemetry: () => makeVercelTelemetry({ content: sdk.config()?.content ?? "full" }),
  spanProcessors: sdk.spanProcessors,
  forceFlush: sdk.forceFlush,
  shutdown: sdk.shutdown,
};

export type Fancy = typeof fancy;
