import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR, CONTENT_ATTRIBUTES, CONTENT_ATTRIBUTE_MAX_BYTES } from "../contract.js";
import { debug, warnOnce } from "../diagnostics.js";

export type ContentMode = "full" | "none";

export interface ContentPolicy {
  content: ContentMode;
  /**
   * Applied to each content attribute's serialized value before export. The
   * value arrives already serialized — a non-string attribute reaches the
   * redactor as `JSON.stringify(value)`, which is the form the GenAI
   * conventions carry these in and the form exported as `stringValue`. The
   * returned string is byte-capped afterwards, so a redactor may return
   * something longer than it was given. A redactor that throws or returns a
   * non-string drops the attribute: an unredacted prompt must never be the
   * fallback.
   */
  redact?: (value: string, attribute: string) => string;
  maxBytes?: number;
}

const PAYLOAD_TOO_LARGE = 413;

// 413 is absent from OTel's retryable list (429/502/503/504), so it always
// reaches the exporter callback as a failure rather than being retried inside
// the transport. The node transport reports it as OTLPExporterError, whose
// `code` carries the HTTP status; the fetch transport used on edge runtimes
// builds a plain Error and keeps the status only in its message, so that form
// is matched too. Neither shape uses a `status` field.
const STATUS_IN_MESSAGE = new RegExp(`\\bstatus ${PAYLOAD_TOO_LARGE}\\b`);

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === PAYLOAD_TOO_LARGE) return true;
  return typeof message === "string" && STATUS_IN_MESSAGE.test(message);
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a code point. */
function truncateUtf8(value: string, max: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= max) return value;
  let end = max;
  // Back up over continuation bytes (10xxxxxx) so we never end mid-sequence.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Enforces the content policy at the process's only exit. Builds a sanitized
 * copy of each span (prototype-chained to the original so its methods and
 * fields stay reachable) and never mutates a ReadableSpan — onEnd hands
 * processors a read-only span, so an exporter decorator is the seam. Also
 * implements the ingest's 413 contract: halve the batch and retry.
 *
 * Only `attributes` is an own property of the copy; `name`, `events`, `links`,
 * `status`, `parentSpanContext` and the rest are inherited. A consumer that
 * enumerates own keys therefore sees one field, while a consumer that reads
 * named properties sees the whole span — which is what OTel's serializer does,
 * and what the round-trip test in this module's suite pins.
 */
export class ContentPolicyExporter implements SpanExporter {
  private readonly maxBytes: number;

  constructor(
    private readonly inner: SpanExporter,
    private readonly policy: ContentPolicy,
  ) {
    this.maxBytes = policy.maxBytes ?? CONTENT_ATTRIBUTE_MAX_BYTES;
  }

  /** The redactor's output, or `null` when it failed and the attribute must go. */
  private redactValue(value: string, key: string): string | null {
    const redact = this.policy.redact;
    if (!redact) return value;
    let out: unknown;
    try {
      out = redact(value, key);
    } catch (error) {
      // The two failures need different fixes — a bug inside the redactor
      // versus a redactor that forgot to return — so they are reported
      // differently. Only the error's kind travels: a redactor that chokes
      // routinely quotes what it was given, and that is the prompt this
      // policy exists to keep out of the host's logs.
      debug(`redact() threw for ${key}`, error instanceof Error ? error.name : typeof error);
      warnOnce(`redact:${key}`, `redact() threw for ${key}; the attribute was dropped`);
      return null;
    }
    if (typeof out === "string") return out;
    warnOnce(
      `redact:${key}`,
      `redact() did not return a string for ${key}; the attribute was dropped`,
    );
    return null;
  }

  private sanitize(span: ReadableSpan): ReadableSpan {
    // Most spans in a batch carry no content at all — instrumentation spans for
    // HTTP calls, database queries, the application's own work. Those are
    // handed on as they are, with no copy.
    if (!CONTENT_ATTRIBUTES.some((key) => span.attributes[key] !== undefined)) return span;
    const attrs: Attributes = { ...span.attributes };
    let truncated = false;
    let contentBytes = 0;
    let exported = 0;
    for (const key of CONTENT_ATTRIBUTES) {
      if (attrs[key] === undefined) continue;
      if (this.policy.content === "none") {
        delete attrs[key];
        continue;
      }
      const serialized = typeof attrs[key] === "string" ? attrs[key] : JSON.stringify(attrs[key]);
      const value = this.redactValue(serialized, key);
      if (value === null) {
        delete attrs[key];
        continue;
      }
      const cut = truncateUtf8(value, this.maxBytes);
      if (cut !== value) truncated = true;
      attrs[key] = cut;
      contentBytes += Buffer.byteLength(cut, "utf8");
      exported++;
    }
    if (truncated) attrs[ATTR.contentTruncated] = true;
    // Counted only when content survived the policy: a span the policy stripped
    // bare would otherwise claim a size of zero rather than no size at all.
    if (exported > 0) attrs[ATTR.contentBytes] = contentBytes;
    return Object.create(span, { attributes: { value: attrs, enumerable: true } }) as ReadableSpan;
  }

  // A 413 is about this batch's size, so both halves are worth sending and the
  // second one goes even when the first came back 413 — otherwise one span
  // over the limit would hold back every span queued behind it. Any other
  // failure is the collector being unreachable, and the descent stops there.
  // Worst case is a full binary descent, 2N-1 requests for N spans, and the
  // batch processor's 30 s export deadline is the backstop that bounds it.
  private exportBatch(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (
        result.code === ExportResultCode.FAILED &&
        isPayloadTooLarge(result.error) &&
        spans.length > 1
      ) {
        const mid = Math.ceil(spans.length / 2);
        this.exportBatch(spans.slice(0, mid), (first) => {
          if (first.code !== ExportResultCode.SUCCESS && !isPayloadTooLarge(first.error)) {
            cb(first);
            return;
          }
          // A synchronous inner exporter would otherwise nest the whole
          // right-hand traversal inside this callback's frame.
          queueMicrotask(() => {
            this.exportBatch(spans.slice(mid), (second) => {
              cb(first.code === ExportResultCode.SUCCESS ? second : first);
            });
          });
        });
        return;
      }
      cb(result);
    });
  }

  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.exportBatch(
      spans.map((s) => this.sanitize(s)),
      cb,
    );
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
