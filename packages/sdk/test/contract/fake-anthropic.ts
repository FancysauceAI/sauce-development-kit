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

const BATCH_MESSAGES = [
  {
    custom_id: "req-a",
    result: {
      type: "succeeded",
      message: {
        id: "msg_batch_a",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "CANARY-SUMMARY-TEXT-7f3a" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12000, output_tokens: 1500 },
      },
    },
  },
  {
    custom_id: "req-b",
    result: {
      type: "succeeded",
      message: {
        id: "msg_batch_b",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1842,
          output_tokens: 376,
          cache_read_input_tokens: 12488,
          cache_creation_input_tokens: 512,
        },
      },
    },
  },
  {
    custom_id: "req-c",
    result: { type: "errored", error: { type: "invalid_request_error", message: "invalid" } },
  },
  { custom_id: "req-d", result: { type: "expired" } },
];

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
  let baseURL = "";
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/messages/batches/msgbatch_fixture01") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "msgbatch_fixture01",
          type: "message_batch",
          processing_status: "ended",
          created_at: "2026-10-04T23:30:00Z",
          ended_at: "2026-10-05T00:40:00Z",
          expires_at: "2026-10-05T23:30:00Z",
          archived_at: null,
          cancel_initiated_at: null,
          results_url: `${baseURL}/v1/messages/batches/msgbatch_fixture01/results`,
          request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 1 },
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/messages/batches/msgbatch_fixture01/results") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(BATCH_MESSAGES.map((result) => JSON.stringify(result)).join("\n") + "\n");
      return;
    }
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
  baseURL = `http://127.0.0.1:${port}`;
  return {
    baseURL,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
