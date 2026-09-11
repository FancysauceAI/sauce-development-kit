import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { createExporter } from "./exporter.js";

interface Received {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** An OTLP collector that answers every request 200 `{}` and records it. */
async function collector(): Promise<{
  endpoint: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function oneSpan(attributes: Record<string, string>): ReadableSpan {
  const mem = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(mem)] });
  provider.getTracer("t").startSpan("chat", { attributes }).end();
  return mem.getFinishedSpans()[0];
}

const exportOnce = (exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> =>
  new Promise<ExportResult>((resolve) => exporter.export(spans, resolve));

describe("createExporter", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("POSTs OTLP/HTTP JSON to /v1/traces with bearer auth and gzip", async () => {
    const c = await collector();
    close = c.close;
    const exporter = createExporter(resolveConfig({ apiKey: "fs_test_k", endpoint: c.endpoint }));
    const result = await exportOnce(exporter, [oneSpan({ "gen_ai.request.model": "m" })]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(c.received).toHaveLength(1);
    const req = c.received[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/traces");
    expect(req.headers.authorization).toBe("Bearer fs_test_k");
    expect(req.headers["content-type"]).toBe("application/json");
    // The node http transport gzips unconditionally when compression is set;
    // there is no size threshold below which it sends the body as-is.
    expect(req.headers["content-encoding"]).toBe("gzip");
    const payload = JSON.parse(gunzipSync(req.body).toString("utf8")) as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[];
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("chat");
    await exporter.shutdown();
  });

  it("applies the content policy before the span reaches the wire", async () => {
    const c = await collector();
    close = c.close;
    const exporter = createExporter(
      resolveConfig({ apiKey: "fs_test_k", endpoint: c.endpoint, content: "none" }),
    );
    await exportOnce(exporter, [
      oneSpan({ "gen_ai.input.messages": "secret", "gen_ai.request.model": "m" }),
    ]);
    const body = gunzipSync(c.received[0].body).toString("utf8");
    expect(body).not.toContain("secret");
    expect(body).toContain("gen_ai.request.model");
    await exporter.shutdown();
  });
});
