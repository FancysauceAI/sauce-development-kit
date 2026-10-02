import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { CONTENT_ATTRIBUTES } from "../../src/contract.js";

export interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Captures POST /v1/traces bodies and answers 200, so a test can assert on the
 * bytes the SDK actually puts on the wire rather than on an in-memory span.
 * Any other method or path is a 404 — matching the fakes in this directory,
 * which answer only the one endpoint their suite calls.
 *
 * The body is gunzipped when the exporter compressed it: `createExporter()`
 * turns gzip on, but a test that builds its own exporter may not, and the
 * recorded fixtures have to come out the same either way.
 */
export async function startReceiver(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
      // A body that fails to parse would otherwise throw inside this
      // listener, where nothing catches it and the process crashes instead of
      // the test failing on a normal assertion.
      let body: unknown;
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch (error) {
        received.push({ headers: req.headers, body: { error: String(error) } });
        res.writeHead(400, { "content-type": "application/json" }).end("{}");
        return;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * The OTLP/HTTP JSON shapes these suites read back off the wire. Only the
 * fields the contract asserts on are declared.
 */
export interface OtlpKeyValue {
  key: string;
  value: Record<string, unknown>;
}

export interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>;
  }>;
}

export const attr = (attrs: OtlpKeyValue[], key: string): Record<string, unknown> | undefined =>
  attrs.find((a) => a.key === key)?.value;

/**
 * `fancysauce.content.bytes` recomputed from the wire, which is what the
 * ingest does with it: the UTF-8 size of the content attributes as exported.
 * The keys come from the contract rather than from a per-suite list, and a key
 * the span does not carry contributes nothing — counting the string
 * "undefined" would put nine bytes into the total for content that is not
 * there.
 */
export const contentBytes = (attrs: OtlpKeyValue[]): number =>
  CONTENT_ATTRIBUTES.reduce((total, key) => {
    const value = attr(attrs, key)?.stringValue;
    return total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
  }, 0);
