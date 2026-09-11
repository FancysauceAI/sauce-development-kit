import { createServer } from "node:http";

/**
 * A fixed chat completion, so the recorded span carries the same token counts
 * on every run. `cached_tokens` is present because the ingest reads it as a
 * separate cost tier.
 */
export const OPENAI_CHAT_RESPONSE = {
  id: "chatcmpl-fixture-1",
  object: "chat.completion",
  created: 1789000000,
  model: "gpt-5-mini-2026-06-01",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Refund started for invoice 4412." },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 1842,
    completion_tokens: 376,
    total_tokens: 2218,
    prompt_tokens_details: { cached_tokens: 1200 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
};

/**
 * Answers the one endpoint this suite calls; everything else is a 404. The
 * request bodies are kept so a test can assert what the provider SDK was
 * actually sent — the per-call `fancysauce` override must never reach it.
 */
export async function startFakeOpenAI(): Promise<{
  baseURL: string;
  requests: unknown[];
  close: () => Promise<void>;
}> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(OPENAI_CHAT_RESPONSE));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
