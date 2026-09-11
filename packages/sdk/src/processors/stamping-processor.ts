import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { AttributionContext } from "../attribution/context.js";
import { ATTR } from "../contract.js";

/**
 * Copies the active attribution scope onto every span at start. onStart on a
 * live span is the contract-blessed place to set attributes; onEnd receives a
 * read-only span. For the reserved standard keys, an attribute the
 * instrumentation set at creation wins over the ambient one — an explicit
 * conversation id on the span is more specific than the scope's.
 */
export class StampingProcessor implements SpanProcessor {
  constructor(private readonly ctx: AttributionContext) {}

  onStart(span: Span, _parent: Context): void {
    const scope = this.ctx.current();
    for (const [k, v] of Object.entries(scope.attribution))
      span.setAttribute(ATTR.attributionPrefix + k, v);
    for (const [k, v] of Object.entries(scope.metadata))
      span.setAttribute(ATTR.metadataPrefix + k, v);
    for (const [k, v] of Object.entries(scope.reserved))
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
