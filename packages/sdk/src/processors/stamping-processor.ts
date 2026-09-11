import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { EMPTY_SCOPE, type AttributionContext, type Scope } from "../attribution/context.js";
import { ATTR } from "../contract.js";

/**
 * Copies the active attribution scope onto every span at start. onStart on a
 * live span is the contract-blessed place to set attributes; onEnd receives a
 * read-only span.
 *
 * Four tiers decide what a span ends up carrying:
 *
 * 1. A per-call override, which arrives as a one-call *scope* and never as
 *    pre-set span attributes. That is why `fancysauce.*` is written
 *    unconditionally: the namespace is written only by the SDK, and the scope
 *    reaching this processor has already been merged inner-over-outer.
 * 2. For the reserved standard keys, an attribute the instrumentation or the
 *    sampler set at span creation wins — an explicit conversation id on the
 *    span is more specific than the ambient one.
 * 3. The ambient scope, which supplies whatever the two above did not.
 * 4. `base`, the process-wide defaults from init(). They also ride on the
 *    resource, but the ingest reads identity from span attributes, so a span
 *    that never entered a scope still has to carry them.
 *
 * Stamping at onStart also places attribution ahead of the 128-attribute cap
 * that per-message instrumentation attributes can hit, so attribution is never
 * what gets dropped.
 */
export class StampingProcessor implements SpanProcessor {
  constructor(
    private readonly ctx: AttributionContext,
    private readonly base: Scope = EMPTY_SCOPE,
  ) {}

  onStart(span: Span, _parent: Context): void {
    const scope = this.ctx.current();
    // `base` first and the scope second: the second setAttribute wins, which
    // is the precedence a caller expects from a default.
    for (const [k, v] of Object.entries(this.base.attribution))
      span.setAttribute(ATTR.attributionPrefix + k, v);
    for (const [k, v] of Object.entries(scope.attribution))
      span.setAttribute(ATTR.attributionPrefix + k, v);
    for (const [k, v] of Object.entries(this.base.metadata))
      span.setAttribute(ATTR.metadataPrefix + k, v);
    for (const [k, v] of Object.entries(scope.metadata))
      span.setAttribute(ATTR.metadataPrefix + k, v);
    // The reserved keys are merged before the guard rather than written in two
    // passes: writing `base` first would make the span carry it, and the
    // scope's own value would then lose to the guard meant for instrumentation.
    const reserved =
      this.base === EMPTY_SCOPE ? scope.reserved : { ...this.base.reserved, ...scope.reserved };
    for (const [k, v] of Object.entries(reserved))
      if (span.attributes[k] === undefined) span.setAttribute(k, v);
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
