import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ResolvedConfig } from "../config.js";
import { ContentPolicyExporter } from "./content-policy-exporter.js";

/**
 * OTLP/HTTP JSON to `${endpoint}/v1/traces`, gzip, bearer auth. The base
 * exporter retries 429/502/503/504 with backoff and honors Retry-After; the
 * decorator adds the content policy and the ingest's 413 halving.
 */
export function createExporter(cfg: ResolvedConfig): SpanExporter {
  // Built from the parsed URL rather than by concatenation, so an endpoint
  // carrying a base path keeps it: `https://host/base` posts to
  // `https://host/base/v1/traces`. resolveConfig() has already stripped any
  // trailing slash and refused a query string or fragment, which is what makes
  // appending to the path the whole of the join.
  const url = new URL(cfg.endpoint);
  url.pathname = `${url.pathname === "/" ? "" : url.pathname}/v1/traces`;
  const otlp = new OTLPTraceExporter({
    url: url.toString(),
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    compression: CompressionAlgorithm.GZIP,
    timeoutMillis: 10_000,
  });
  return new ContentPolicyExporter(otlp, { content: cfg.content, redact: cfg.redact });
}
