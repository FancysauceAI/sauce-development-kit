import { createHash } from "node:crypto";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { RandomIdGenerator, type IdGenerator } from "@opentelemetry/sdk-trace-base";
import type { AttributionContext } from "../attribution/context.js";
import type { BagInput } from "../attribution/normalize.js";
import { ATTR, SERVICE_TIER_BATCH } from "../contract.js";
import { debug, warnOnce } from "../diagnostics.js";
import type { BatchWriter } from "./writer.js";

/** Token counts for one batch result, as the provider billed them. */
export interface BatchResultUsage {
  /** Input tokens billed at the input rate. Excludes cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadInputTokens?: number | null | undefined;
  /** Input tokens written to the prompt cache. */
  cacheCreationInputTokens?: number | null | undefined;
}

/** One billed result of a provider batch API, such as Anthropic Message Batches. */
export interface BatchResult {
  /** The provider, as gen_ai.provider.name: "anthropic", "openai", ... */
  provider: string;
  /** The provider's id for the batch. */
  batchId: string;
  /** The id the caller gave this request inside the batch. */
  customId: string;
  /** The model that served the request, as the result reports it. */
  model: string;
  usage: BatchResultUsage;
  /** The provider's id for the response, when the result has one. */
  responseId?: string;
  /** Why generation stopped, as the provider reports it. */
  finishReason?: string;
  /** When the batch was created. Default: endTime. */
  startTime?: Date;
  /** When the batch ended. Default: now. */
  endTime?: Date;
  /** Attribution for this request. Merged over the init() defaults and any active scope. */
  attribution?: BagInput;
  /** Metadata for this request. */
  metadata?: BagInput;
}

export const BATCH_SCOPE = "@fancysauce/sdk/batch";

function digest(parts: string[], length: number): string {
  const id = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, length);
  return /^0+$/.test(id) ? `${id.slice(0, -1)}1` : id;
}

export function batchTraceId(provider: string, batchId: string): string {
  return digest(["fancysauce-batch-trace", provider, batchId], 32);
}

export function batchSpanId(provider: string, batchId: string, customId: string): string {
  return digest(["fancysauce-batch-span", provider, batchId, customId], 16);
}

export class SlotIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  private pending?: { traceId: string; spanId: string };

  use<T>(ids: { traceId: string; spanId: string }, fn: () => T): T {
    this.pending = ids;
    try {
      return fn();
    } finally {
      this.pending = undefined;
    }
  }

  // startSpan reads the span id first and the trace id only for a root span;
  // both reads happen synchronously inside use().
  generateTraceId(): string {
    return this.pending?.traceId ?? this.random.generateTraceId();
  }

  generateSpanId(): string {
    return this.pending?.spanId ?? this.random.generateSpanId();
  }
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value: Date | undefined): Date | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : undefined;
}

function invalid(field: string): false {
  warnOnce(
    `batch:invalid:${field}`,
    `fancy.recordBatchResult() dropped a result with an invalid ${field}`,
  );
  return false;
}

function validate(result: BatchResult): boolean {
  for (const field of ["provider", "batchId", "customId", "model"] as const)
    if (!validName(result?.[field])) return invalid(field);
  if (!result.usage || typeof result.usage !== "object") return invalid("usage");
  for (const field of ["inputTokens", "outputTokens"] as const)
    if (!validCount(result.usage[field])) return invalid(`usage.${field}`);
  for (const field of ["cacheReadInputTokens", "cacheCreationInputTokens"] as const) {
    const value = result.usage[field];
    if (value != null && !validCount(value)) return invalid(`usage.${field}`);
  }
  return true;
}

/** Records a single billed result as a content-free LLM call span. */
export function recordBatchResult(
  result: BatchResult,
  tracer: Tracer | undefined,
  ids: SlotIdGenerator | undefined,
  ctx: AttributionContext,
  writer: BatchWriter | undefined,
): Promise<boolean> {
  if (!tracer || !ids || !writer) {
    warnOnce(
      "batch:preinit",
      "fancy.recordBatchResult() called before fancy.init(); the result was not recorded",
    );
    return Promise.resolve(false);
  }
  try {
    if (!validate(result)) return Promise.resolve(false);
    const end = validDate(result.endTime) ?? new Date();
    const maybeStart = validDate(result.startTime) ?? end;
    const start = maybeStart > end ? end : maybeStart;
    const attributes: Record<string, string | number | string[]> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": result.provider,
      "gen_ai.request.model": result.model,
      "gen_ai.response.model": result.model,
      "gen_ai.usage.input_tokens": result.usage.inputTokens,
      "gen_ai.usage.output_tokens": result.usage.outputTokens,
      [ATTR.batchId]: result.batchId,
      [ATTR.batchCustomId]: result.customId,
      [ATTR.serviceTier]: SERVICE_TIER_BATCH,
    };
    if (result.responseId !== undefined) attributes["gen_ai.response.id"] = result.responseId;
    if (result.finishReason !== undefined)
      attributes["gen_ai.response.finish_reasons"] = [result.finishReason];
    if (result.usage.cacheReadInputTokens != null)
      attributes["gen_ai.usage.cache_read.input_tokens"] = result.usage.cacheReadInputTokens;
    if (result.usage.cacheCreationInputTokens != null)
      attributes["gen_ai.usage.cache_creation.input_tokens"] =
        result.usage.cacheCreationInputTokens;

    const scope = ctx.capture(result.attribution ?? {}, { metadata: result.metadata ?? {} });
    return writer.admit(() => {
      try {
        ctx.runWith(scope, () =>
          ids.use(
            {
              traceId: batchTraceId(result.provider, result.batchId),
              spanId: batchSpanId(result.provider, result.batchId, result.customId),
            },
            () => {
              const span = tracer.startSpan(
                `chat ${result.model}`,
                { kind: SpanKind.CLIENT, startTime: start, root: true, attributes },
                ROOT_CONTEXT,
              );
              span.setStatus({ code: SpanStatusCode.OK });
              span.end(end);
            },
          ),
        );
        return true;
      } catch (error) {
        warnOnce(
          "batch:record",
          "fancy.recordBatchResult() could not record a result; it was dropped",
        );
        debug("batch result recording failed", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        return false;
      }
    });
  } catch (error) {
    warnOnce("batch:record", "fancy.recordBatchResult() could not record a result; it was dropped");
    debug("batch result recording failed", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return Promise.resolve(false);
  }
}
