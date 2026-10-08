/** The provider batch results become content-free, individually attributed SDK spans. */
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fancy } from "../../src/index.js";
import { startFakeAnthropic } from "./fake-anthropic.js";
import { attr, startReceiver, type OtlpExportRequest } from "./otlp-receiver.js";
import { recordOrCompare } from "./recording.js";

const OUT = join(import.meta.dirname, "out");
const CANARY = "CANARY-SUMMARY-TEXT-7f3a";

describe("Anthropic batch contract", () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  let provider: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined;

  beforeAll(async () => {
    receiver = await startReceiver();
    provider = await startFakeAnthropic();
    fancy.init({
      apiKey: "fs_test_contract",
      name: "batch-worker",
      endpoint: receiver.url,
      content: "none",
    });
  });

  afterAll(async () => {
    await fancy.shutdown();
    await provider?.close();
    await receiver?.close();
  });

  it("records each succeeded result without sending response content", async () => {
    const client = new Anthropic({ apiKey: "sk-ant-test", baseURL: provider!.baseURL });
    const batch = await client.messages.batches.retrieve("msgbatch_fixture01");
    const results = await client.messages.batches.results(batch.id);
    for await (const item of results) {
      if (item.result.type !== "succeeded") continue;
      const { message } = item.result;
      const admitted = await fancy.recordBatchResult({
        provider: "anthropic",
        batchId: batch.id,
        customId: item.custom_id,
        model: message.model,
        responseId: message.id,
        finishReason: message.stop_reason ?? undefined,
        startTime: new Date(batch.created_at),
        endTime: batch.ended_at ? new Date(batch.ended_at) : undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadInputTokens: message.usage.cache_read_input_tokens,
          cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
        },
        attribution: { customer: "tenant-1", member: "u-1", product: "nightly-digest" },
      });
      if (!admitted) throw new Error("Batch result was not recorded");
    }
    await fancy.forceFlush();

    expect(receiver!.received).toHaveLength(1);
    const body = receiver!.received[0].body as OtlpExportRequest;
    const spans = body.resourceSpans[0].scopeSpans.flatMap((scope) => scope.spans);
    expect(spans).toHaveLength(2);
    expect(
      spans.map((span) => attr(span.attributes, "fancysauce.batch.custom_id")?.stringValue),
    ).toEqual(["req-a", "req-b"]);
    const attributes = spans.map((span) => span.attributes);
    expect(attr(attributes[0], "gen_ai.usage.input_tokens")).toEqual({ intValue: 12000 });
    expect(attr(attributes[0], "gen_ai.usage.output_tokens")).toEqual({ intValue: 1500 });
    expect(attr(attributes[1], "gen_ai.usage.input_tokens")).toEqual({ intValue: 1842 });
    expect(attr(attributes[1], "gen_ai.usage.output_tokens")).toEqual({ intValue: 376 });
    expect(attr(attributes[1], "gen_ai.usage.cache_read.input_tokens")).toEqual({
      intValue: 12488,
    });
    expect(attr(attributes[1], "gen_ai.usage.cache_creation.input_tokens")).toEqual({
      intValue: 512,
    });
    expect(
      attributes.every((a) => attr(a, "fancysauce.service_tier")?.stringValue === "batch"),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    recordOrCompare(join(OUT, "anthropic-batch.otlp.json"), body);
  });
});
