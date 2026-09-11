import { context, createContextKey, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AttributionContext,
  type AttributeFn,
  type AttributeOptions,
} from "./attribution/context.js";
import { normalizeBag, type BagInput } from "./attribution/normalize.js";
import { resolveConfig, type InitOptions, type ResolvedConfig } from "./config.js";
import { ATTR, SCHEMA_VERSION } from "./contract.js";
import { setDebug, warnOnce } from "./diagnostics.js";
import { ContentPolicyExporter } from "./export/content-policy-exporter.js";
import { createExporter } from "./export/exporter.js";
import { StampingProcessor } from "./processors/stamping-processor.js";

export interface SdkInternals {
  /** Test seam: replaces the OTLP exporter; the content policy still wraps it. */
  exporterFactory?: (cfg: ResolvedConfig) => SpanExporter;
}

const PROBE_KEY = createContextKey("fancysauce context manager probe");

// The API offers no way to ask which context manager is installed, so this asks
// behaviorally: the no-op manager runs the callback but never makes the context
// active. Used to avoid replacing a manager the application already installed.
function hasContextManager(): boolean {
  return context.with(
    ROOT_CONTEXT.setValue(PROBE_KEY, true),
    () => context.active().getValue(PROBE_KEY) === true,
  );
}

export function createSdk(internals: SdkInternals = {}) {
  let cfg: ResolvedConfig | undefined;
  let ctx = new AttributionContext({ mode: "auto" });
  let provider: NodeTracerProvider | undefined;
  let processors: SpanProcessor[] = [];

  // A stable callable that reads `ctx` at call time rather than at hand-out
  // time. The alternative — exposing ctx.attribute through a getter — breaks
  // for `const { attribute } = fancy`, and for any module that re-exports it as
  // a binding, because both capture the pre-init() context.
  const attribute = Object.assign(
    <T>(bag: BagInput, optsOrFn: AttributeOptions | (() => T), maybeFn?: () => T): T =>
      (ctx.attribute as (b: BagInput, o: AttributeOptions | (() => T), f?: () => T) => T)(
        bag,
        optsOrFn,
        maybeFn,
      ),
    {
      start: (bag: BagInput, opts?: AttributeOptions): void => ctx.attribute.start(bag, opts),
      add: (bag: BagInput, opts?: AttributeOptions): void => ctx.attribute.add(bag, opts),
      end: (key?: string): void => ctx.attribute.end(key),
    },
  ) as AttributeFn;

  function init(options: InitOptions): void {
    if (cfg) {
      warnOnce("init:twice", "fancy.init() called more than once; keeping the first configuration");
      return;
    }
    const resolved = resolveConfig(options);
    setDebug(resolved.debug);
    const nextCtx = new AttributionContext({ mode: resolved.context });
    const defaults = normalizeBag(resolved.attribution);
    // Process-wide defaults belong on the resource, not on every span: they are
    // constant for the life of the process, and the reserved keys among them
    // are the key-bound identity a single-user tool reports once.
    const resource = resourceFromAttributes({
      ...(resolved.name ? { "service.name": resolved.name } : {}),
      ...(resolved.version ? { "service.version": resolved.version } : {}),
      [ATTR.schemaVersion]: SCHEMA_VERSION,
      [ATTR.sdkVersion]: __SDK_VERSION__,
      ...Object.fromEntries(
        Object.entries(defaults.attribution).map(([k, v]) => [ATTR.attributionPrefix + k, v]),
      ),
      ...defaults.reserved,
    });
    const raw = internals.exporterFactory?.(resolved);
    const exporter = raw
      ? new ContentPolicyExporter(raw, { content: resolved.content, redact: resolved.redact })
      : createExporter(resolved);
    const nextProcessors: SpanProcessor[] = [
      new StampingProcessor(nextCtx),
      new BatchSpanProcessor(exporter, { maxExportBatchSize: 64, scheduledDelayMillis: 2000 }),
    ];
    const nextProvider = new NodeTracerProvider({ resource, spanProcessors: nextProcessors });
    if (!trace.setGlobalTracerProvider(nextProvider)) {
      warnOnce(
        "init:provider",
        "an OpenTelemetry tracer provider is already registered; pass fancy.spanProcessors() to it or call fancy.init() first",
      );
    }
    // NodeTracerProvider installs a context manager only from register(), which
    // would also claim the global provider and propagator. We claim the
    // provider above so the already-registered case stays visible, which leaves
    // the context manager to install here — without one, context.active() never
    // holds a span and every span the application starts is a root span.
    if (!hasContextManager()) {
      const manager = new AsyncLocalStorageContextManager();
      manager.enable();
      context.setGlobalContextManager(manager);
    }
    cfg = resolved;
    ctx = nextCtx;
    provider = nextProvider;
    processors = nextProcessors;
  }

  return {
    init,
    config: (): ResolvedConfig | undefined => cfg,
    /** For applications that own their tracer provider: register these on it. */
    spanProcessors: (): SpanProcessor[] => processors,
    attribute,
    context: (): AttributionContext => ctx,
    forceFlush: async (): Promise<void> => {
      await provider?.forceFlush();
    },
    shutdown: async (): Promise<void> => {
      await provider?.shutdown();
      provider = undefined;
      cfg = undefined;
      processors = [];
      ctx = new AttributionContext({ mode: "auto" });
    },
  };
}
