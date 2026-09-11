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
  const otlp = new OTLPTraceExporter({
    url: `${cfg.endpoint}/v1/traces`,
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    compression: CompressionAlgorithm.GZIP,
    timeoutMillis: 10_000,
  });
  return new ContentPolicyExporter(otlp, { content: cfg.content, redact: cfg.redact });
}
