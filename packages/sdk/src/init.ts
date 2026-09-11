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
  reportDrops,
  type AttributeFn,
  type AttributeOptions,
} from "./attribution/context.js";
import { normalizeBag, type BagInput } from "./attribution/normalize.js";
import { resolveConfig, type InitOptions, type ResolvedConfig } from "./config.js";
import { ATTR, SCHEMA_VERSION } from "./contract.js";
import { setDebug, warnOnce } from "./diagnostics.js";
import { ContentPolicyExporter } from "./export/content-policy-exporter.js";
import { createExporter } from "./export/exporter.js";
import {
  InstrumentRegistry,
  type ClassPatch,
  type InstrumentOptions,
} from "./instrument/registry.js";
import { StampingProcessor } from "./processors/stamping-processor.js";

export interface SdkInternals {
  /** Test seam: replaces the OTLP exporter; the content policy still wraps it. */
  exporterFactory?: (cfg: ResolvedConfig) => SpanExporter;
  /** Test seam: replaces the OpenLLMetry class patch instrument() applies. */
  instrumentPatch?: ClassPatch;
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
  let registry: InstrumentRegistry | undefined;
  // shutdown() releases only what init() claimed. An application that installed
  // its own context manager keeps it.
  let installedContextManager = false;

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

  /**
   * Wraps an OpenAI or Anthropic client so its calls carry attribution, and
   * patches its class so they produce spans.
   */
  function instrument<T extends object>(client: T, opts?: InstrumentOptions): T {
    if (!cfg)
      throw new Error(
        "fancy.instrument(): call fancy.init() first — the client's spans need the tracer provider and the content policy init() resolves",
      );
    // Built here rather than in init(), so the registry binds the context and
    // the content policy of the configuration that is actually in force; the
    // next init() after a shutdown() builds a new one.
    registry ??= new InstrumentRegistry(ctx, {
      traceContent: cfg.content === "full",
      patch: internals.instrumentPatch,
    });
    return registry.instrument(client, opts);
  }

  function init(options: InitOptions): void {
    if (cfg) {
      warnOnce("init:twice", "fancy.init() called more than once; keeping the first configuration");
      return;
    }
    const resolved = resolveConfig(options);
    setDebug(resolved.debug);
    const nextCtx = new AttributionContext({ mode: resolved.context });
    const defaults = normalizeBag(resolved.attribution);
    reportDrops(defaults.dropped, "attribution");
    // Process-wide defaults ride on the resource, where they are written once
    // per export rather than once per span. They are stamped on every span too
    // (see StampingProcessor's `base`) because the ingest reads identity from
    // span attributes; the resource copy is what survives a span the SDK's
    // processor never saw.
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
      new StampingProcessor(nextCtx, {
        attribution: defaults.attribution,
        metadata: {},
        reserved: defaults.reserved,
      }),
      // Passing these takes the processor off its OTEL_BSP_* environment knobs,
      // which is the trade: the queue is a memory ceiling and the SDK owns it.
      // Worst case a span carries three content attributes of 256 KB each, so
      // 512 queued spans is the ~390 MB ceiling chosen here. The batch stays at
      // 64 spans because the ingest caps a request at 8 MB and the exporter's
      // 413 halving is what handles the batches that still exceed it — a
      // byte-budgeted pre-split is a later optimization.
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 512,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 2000,
      }),
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
    if (resolved.registerContextManager && !hasContextManager()) {
      const manager = new AsyncLocalStorageContextManager();
      manager.enable();
      if (context.setGlobalContextManager(manager)) installedContextManager = true;
      else {
        manager.disable();
        warnOnce("init:ctxmgr", "could not install a context manager; spans may not nest");
      }
    }
    cfg = resolved;
    ctx = nextCtx;
    provider = nextProvider;
    processors = nextProcessors;
  }

  return {
    init,
    instrument,
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
      // The global tracer proxy keeps delegating to a shut-down provider
      // forever, and setGlobalTracerProvider refuses to replace one that is
      // still registered — so a shutdown that does not release the global
      // makes every later init() a no-op that silently drops every span.
      trace.disable();
      if (installedContextManager) {
        context.disable();
        installedContextManager = false;
      }
      provider = undefined;
      cfg = undefined;
      processors = [];
      registry = undefined;
      ctx = new AttributionContext({ mode: "auto" });
    },
  };
}
