import { sdk } from "./process-sdk.js";

export type { VercelTelemetry } from "./vercel-telemetry.js";

/**
 * The `@fancysauce/sdk/vercel` subpath, for a module that wants the one helper
 * rather than the whole surface. It is the same function as
 * `fancy.vercelTelemetry`, bound to the same process SDK, so it reads the
 * content policy `fancy.init()` resolved.
 */
export const vercelTelemetry = sdk.vercelTelemetry;
