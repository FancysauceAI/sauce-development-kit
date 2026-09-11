import type { BagInput } from "./attribution/normalize.js";
import type { ContextMode } from "./attribution/context.js";
import type { ContentMode } from "./export/content-policy-exporter.js";

export interface InitOptions {
  /** Fancysauce API key (`fs_live_…` or `fs_test_…`). */
  apiKey: string;
  /** How this application appears in the dashboard. Becomes `service.name`. */
  name?: string;
  /** Application version. Becomes `service.version`. */
  version?: string;
  /** Ingest base URL. Default https://ingest.fancysauce.ai */
  endpoint?: string;
  /** Process-wide attribution defaults, e.g. { environment: "prod" }. */
  attribution?: BagInput;
  /** Capture prompt and response content. Default "full". */
  content?: ContentMode;
  /** Runs on each content attribute's serialized value before it leaves the process. */
  redact?: (value: string, attribute: string) => string;
  /**
   * "auto" (default) isolates flows with AsyncLocalStorage; "global" is
   * single-flow mode for scripts and batch jobs.
   */
  context?: ContextMode;
  /** Log SDK internals with console.debug. */
  debug?: boolean;
}

/** Every option with its default applied, which is what the rest of the SDK reads. */
export interface ResolvedConfig {
  apiKey: string;
  name: string | undefined;
  version: string | undefined;
  endpoint: string;
  attribution: BagInput;
  content: ContentMode;
  redact: InitOptions["redact"];
  context: ContextMode;
  debug: boolean;
}

export const DEFAULT_ENDPOINT = "https://ingest.fancysauce.ai";

/**
 * Rejects the two mistakes that would otherwise surface as silent data loss
 * hours later: no key, and an endpoint the OTLP exporter cannot parse.
 */
export function resolveConfig(options: InitOptions): ResolvedConfig {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0)
    throw new Error("fancy.init(): apiKey is required");
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(endpoint))
    throw new Error("fancy.init(): endpoint must be an http(s) URL");
  return {
    apiKey: options.apiKey,
    name: options.name,
    version: options.version,
    endpoint,
    attribution: options.attribution ?? {},
    content: options.content ?? "full",
    redact: options.redact,
    context: options.context ?? "auto",
    debug: options.debug ?? false,
  };
}
