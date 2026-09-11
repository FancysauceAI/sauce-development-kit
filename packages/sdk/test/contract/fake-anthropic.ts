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
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(ANTHROPIC_MESSAGE_RESPONSE));
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
