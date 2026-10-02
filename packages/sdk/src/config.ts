import { warnOnce } from "./diagnostics.js";
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
  /**
   * Ingest base URL. Default https://ingest.fancysauce.ai. Must be https
   * unless the host is loopback.
   */
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
  /**
   * Build a tracer provider and register it globally. Default true. Set false
   * when the application owns its own provider: init() then builds only the
   * span processors, which `fancy.spanProcessors()` hands back for the host to
   * construct its provider with, and installs no context manager either.
   */
  registerProvider?: boolean;
  /**
   * Install an AsyncLocalStorage context manager when none is present. Default
   * true. Set false when the host installs its own later in startup, which
   * would otherwise leave two managers disagreeing about the active span.
   */
  registerContextManager?: boolean;
  /**
   * Log SDK internals with console.debug: the attribution, metadata and
   * reserved key names on each scope, and the reason a key was dropped. Never
   * the values — those are customer identifiers, and this goes to your logs.
   */
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
  registerProvider: boolean;
  registerContextManager: boolean;
  debug: boolean;
}

export const DEFAULT_ENDPOINT = "https://ingest.fancysauce.ai";

// The exception to requiring https: a local collector or a test receiver has no
// certificate, and its traffic never leaves the machine. Every other host would
// be putting prompts, responses and an API key on the wire in the clear.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Rejects the mistakes that would otherwise surface hours later as silent data
 * loss or as prompts on the wire in the clear: no key, an endpoint the OTLP
 * exporter cannot parse, and a plaintext endpoint pointed anywhere but
 * loopback. A key that does not look like ours is warned about, not rejected.
 */
export function resolveConfig(options: InitOptions): ResolvedConfig {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0)
    throw new Error("fancy.init(): apiKey is required");
  // Trailing slashes are stripped by scanning, not by `/\/+$/`: a regex with an
  // unbounded repeat anchored at the end is quadratic on hostile input, and the
  // endpoint is caller-controlled.
  let endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("fancy.init(): endpoint must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("fancy.init(): endpoint must be an http(s) URL");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname))
    throw new Error(
      "fancy.init(): endpoint must be an https URL; plain http is accepted only for a loopback host (localhost, 127.0.0.1, [::1])",
    );
  // The endpoint is a base URL the exporter appends a path to, so a query or a
  // fragment on it has nowhere to go: it would land before `/v1/traces` on a
  // route the ingest does not serve, and a credential written into it would
  // ride on every request line.
  if (url.search !== "" || url.hash !== "")
    throw new Error("fancy.init(): endpoint must be a base URL, with no query string or fragment");
  // A key from another vendor is a configuration mix-up the ingest will reject
  // with a 401 an hour later. Warning beats throwing: the prefix is a
  // convention, and refusing to start over one would be the SDK taking the
  // application down for its own bookkeeping.
  if (!options.apiKey.startsWith("fs_"))
    warnOnce(
      "config:apikey",
      'fancy.init(): apiKey does not look like a Fancysauce key (expected an "fs_" prefix)',
    );
  return {
    apiKey: options.apiKey,
    name: options.name,
    version: options.version,
    endpoint,
    attribution: options.attribution ?? {},
    content: options.content ?? "full",
    redact: options.redact,
    context: options.context ?? "auto",
    registerProvider: options.registerProvider ?? true,
    registerContextManager: options.registerContextManager ?? true,
    debug: options.debug ?? false,
  };
}
