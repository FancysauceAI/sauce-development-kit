import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ATTR, CONTENT_ATTRIBUTES, CONTENT_ATTRIBUTE_MAX_BYTES } from "../contract.js";

export type ContentMode = "full" | "none";

export interface ContentPolicy {
  content: ContentMode;
  /** Applied to each content attribute's serialized value before export. */
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
 */
export class ContentPolicyExporter implements SpanExporter {
  private readonly maxBytes: number;

  constructor(
    private readonly inner: SpanExporter,
    private readonly policy: ContentPolicy,
  ) {
    this.maxBytes = policy.maxBytes ?? CONTENT_ATTRIBUTE_MAX_BYTES;
  }

  private sanitize(span: ReadableSpan): ReadableSpan {
    const attrs: Attributes = { ...span.attributes };
    let truncated = false;
    for (const key of CONTENT_ATTRIBUTES) {
      if (attrs[key] === undefined) continue;
      if (this.policy.content === "none") {
        delete attrs[key];
        continue;
      }
      let value = typeof attrs[key] === "string" ? attrs[key] : JSON.stringify(attrs[key]);
      if (this.policy.redact) value = this.policy.redact(value, key);
      const cut = truncateUtf8(value, this.maxBytes);
      if (cut !== value) truncated = true;
      attrs[key] = cut;
    }
    if (truncated) attrs[ATTR.contentTruncated] = true;
    return Object.create(span, { attributes: { value: attrs, enumerable: true } }) as ReadableSpan;
  }

  private exportBatch(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (
        result.code === ExportResultCode.FAILED &&
        isPayloadTooLarge(result.error) &&
        spans.length > 1
      ) {
        const mid = Math.ceil(spans.length / 2);
        this.exportBatch(spans.slice(0, mid), (first) => {
          if (first.code !== ExportResultCode.SUCCESS) return cb(first);
          this.exportBatch(spans.slice(mid), cb);
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
