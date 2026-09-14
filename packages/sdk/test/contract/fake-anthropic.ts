import { createServer } from "node:http";

/**
 * A fixed message response, so the recorded span carries the same token counts
 * on every run. The two cache fields are present because the ingest reads each
 * as a separate cost tier.
 */
export const ANTHROPIC_MESSAGE_RESPONSE = {
  id: "msg_fixture_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "Refund started for invoice 4412." }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1842,
    output_tokens: 376,
    cache_read_input_tokens: 12488,
    cache_creation_input_tokens: 512,
  },
};

/**
 * What a structured-output request is answered with, as an object rather than
 * as text, so a test can compare `parsed_output` against the same value the
 * server put on the wire.
 */
export const ANTHROPIC_STRUCTURED_OUTPUT = {
  invoice_id: "INV-4412",
  amount_cents: 128900,
  currency: "USD",
};

/**
 * The structured-output answer. Its usage is the plain response's, so a span
 * from `messages.parse()` is expected to carry exactly the numbers the
 * `messages.create()` case asserts; only the text block differs, because
 * `parse()` reads the message text back through the caller's schema and a
 * prose answer would fail that schema rather than round-trip through it.
 */
export const ANTHROPIC_STRUCTURED_RESPONSE = {
  ...ANTHROPIC_MESSAGE_RESPONSE,
  id: "msg_fixture_2",
  content: [{ type: "text", text: JSON.stringify(ANTHROPIC_STRUCTURED_OUTPUT) }],
};

/**
 * Answers the one endpoint this suite calls; everything else is a 404. The
 * request bodies are kept so a test can assert what the provider SDK was
 * actually sent — the per-call `fancysauce` override must never reach it.
 */
export async function startFakeAnthropic(): Promise<{
  baseURL: string;
  requests: unknown[];
  close: () => Promise<void>;
}> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          output_config?: unknown;
        };
        requests.push(body);
        // A request that asked for a format is answered in that format. The
        // real API branches the same way, and `parse()` throws on an answer
        // that is not the JSON the request asked for.
        const answer = body.output_config
          ? ANTHROPIC_STRUCTURED_RESPONSE
          : ANTHROPIC_MESSAGE_RESPONSE;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
