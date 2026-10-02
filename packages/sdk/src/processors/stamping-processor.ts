import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { EMPTY_SCOPE, type AttributionContext, type Scope } from "../attribution/context.js";
import { ATTR, RESERVED_KEYS, type ReservedKey } from "../contract.js";

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
 *    span is more specific than the ambient one — and it wins for the whole
 *    key, not just for the attribute it happens to occupy.
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
    // Reserved keys are merged raw and expanded once, here: `member` maps to
    // `user.email` or to `user.id` depending on the value, so merging the
    // expanded forms would leave an overridden address beside the id.
    // Merging before the guard also matters — writing `base` first would make
    // the span carry it, and the scope's own value would then lose to the
    // guard meant for instrumentation.
    const reserved =
      this.base === EMPTY_SCOPE ? scope.reserved : { ...this.base.reserved, ...scope.reserved };
    for (const [key, value] of Object.entries(reserved)) {
      if (value === undefined) continue;
      const { attributes, toAttributes } = RESERVED_KEYS[key as ReservedKey];
      // The guard is per reserved key rather than per attribute, and it reads
      // every attribute the key can map to, not just the ones this value
      // writes. `conversation` maps to a pair, so writing half of it would put
      // an ambient `session.id` beside a conversation id the instrumentation
      // chose; `member` maps to `user.email` or `user.id` by value, so an
      // ambient address would sit beside an instrumentation-set id and the
      // call would carry two identities.
      if (attributes.some((a) => span.attributes[a] !== undefined)) continue;
      for (const [k, v] of Object.entries(toAttributes(value))) span.setAttribute(k, v);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
