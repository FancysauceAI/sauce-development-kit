import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { warnOnce } from "../diagnostics.js";
import { VERCEL_TRACER_NAME } from "../vercel-telemetry.js";
import { BATCH_SCOPE } from "../batch/record.js";

/** The scope the Vercel AI SDK names its own tracer. */
const VERCEL_AI_SCOPE = "ai";

/**
 * The scopes an SDK that has instrumented nothing yet already exports: the two
 * the Vercel AI SDK's spans can carry, depending on whether the version in use
 * spans against the tracer `vercelTelemetry()` hands it or against its own,
 * and the SDK's own batch result spans.
 *
 * Everything else is added by `instrument()` as each provider's
 * instrumentation package loads, so a new provider needs no entry here.
 */
export function createScopeAllowList(): Set<string> {
  return new Set([VERCEL_AI_SCOPE, VERCEL_TRACER_NAME, BATCH_SCOPE]);
}

// Bounded for the reason the warning budget is: a host minting tracer names
// from unbounded input would otherwise grow this for the life of the process.
// Past the cap a span from an unseen scope is still dropped; only the count of
// it is not kept.
const MAX_TRACKED_SCOPES = 64;

/**
 * Forwards only the spans this SDK's own instrumentation created, and drops
 * every other span before it reaches the export queue.
 *
 * The SDK exports the spans its wrapped tools emit; it is never a general
 * OpenTelemetry exporter. With `registerProvider` at its default `init()` owns
 * the global tracer provider, so without this filter every span in the process
 * would ship to Fancysauce — the application's own, and any other
 * instrumentation's, carrying whatever request URLs, SQL statements and stack
 * traces those put on them. The content policy reaches none of that: it acts
 * on three GenAI attributes and nothing else.
 *
 * It wraps the batch processor rather than sitting beside it because
 * processors on a provider are peers and a peer cannot veto another. Wrapping
 * is what keeps a dropped span out of the queue rather than merely out of one
 * processor.
 */
export class ScopeFilterProcessor implements SpanProcessor {
  private readonly drops = new Map<string, number>();

  constructor(
    private readonly inner: SpanProcessor,
    /**
     * Read at span end rather than copied: `instrument()` grows this set as
     * each instrumentation package lands, which is after the processors are
     * built.
     */
    private readonly allowed: ReadonlySet<string>,
  ) {}

  /** How many spans were dropped, per scope. Diagnostics only. */
  dropped(): ReadonlyMap<string, number> {
    return this.drops;
  }

  // Forwarded whatever the scope is. onStart is the only point a processor may
  // still write to a live span, and the decision belongs at onEnd, which is
  // where the wrapped processor would enqueue it.
  onStart(span: Span, parent: Context): void {
    this.inner.onStart(span, parent);
  }

  onEnd(span: ReadableSpan): void {
    const scope = span.instrumentationScope.name;
    if (this.allowed.has(scope)) {
      this.inner.onEnd(span);
      return;
    }
    const seen = this.drops.get(scope);
    if (seen !== undefined) {
      this.drops.set(scope, seen + 1);
      return;
    }
    if (this.drops.size < MAX_TRACKED_SCOPES) this.drops.set(scope, 1);
    warnOnce(
      `scope:${scope}`,
      `a span from the "${scope}" instrumentation was not exported: this SDK exports only ` +
        "the spans of the AI clients it instrumented, of the Vercel AI SDK, and its own batch " +
        "result spans. To ship your " +
        "own tracing, send it to a tracer provider of your own — fancy.init({ registerProvider: " +
        "false }) leaves the global one to you",
    );
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
