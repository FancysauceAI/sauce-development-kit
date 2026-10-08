import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { Context } from "@opentelemetry/api";
import { warnOnce } from "../diagnostics.js";
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const CHUNK_SIZE = 64;
const EXPORT_TIMEOUT_MS = 30_000;

/** Serializes batch span creation and exports each bounded chunk before admitting more. */
export class BatchWriter implements SpanProcessor {
  private spans: ReadableSpan[] = [];
  private admissions: Promise<void> = Promise.resolve();
  private failure?: Error;
  private exportInFlight?: Promise<void>;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly exporter: SpanExporter) {}

  onStart(_span: Span, _parent: Context): void {}

  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }

  admit<T>(create: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("batch writer is shut down"));
    const task = this.admissions.then(async () => {
      this.throwFailure();
      if (this.spans.length >= CHUNK_SIZE) await this.exportChunk();
      this.throwFailure();
      return create();
    });
    this.admissions = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async forceFlush(): Promise<void> {
    await this.admissions;
    this.throwFailure();
    await this.exportChunk();
    this.throwFailure();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = (async () => {
      let failure: Error | undefined;
      try {
        await this.admissions;
        this.throwFailure();
        await this.exportChunk();
      } catch (error) {
        failure = this.asError(error);
      }
      try {
        await this.exporter.shutdown();
      } catch (error) {
        failure ??= this.asError(error);
      }
      if (failure !== undefined) throw failure;
      this.throwFailure();
    })();
    return this.shutdownPromise;
  }

  private asError(reason: unknown): Error {
    return reason instanceof Error
      ? reason
      : new Error("batch span export failed", { cause: reason });
  }

  private throwFailure(): void {
    if (this.failure) throw this.failure;
  }

  private exportChunk(): Promise<void> {
    if (this.exportInFlight) return this.exportInFlight;
    const spans = this.spans.splice(0, CHUNK_SIZE);
    if (!spans.length) return Promise.resolve();
    const wrapped = this.exportSpans(spans).finally(() => {
      if (this.exportInFlight === wrapped) this.exportInFlight = undefined;
    });
    this.exportInFlight = wrapped;
    return wrapped;
  }

  private async exportSpans(spans: ReadableSpan[]): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined) reject(this.asError(error));
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error("batch span export timed out")),
          EXPORT_TIMEOUT_MS,
        );
        try {
          this.exporter.export(spans, (result: ExportResult) => {
            finish(
              result.code === ExportResultCode.SUCCESS
                ? undefined
                : (result.error ?? new Error("batch span export failed")),
            );
          });
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      this.failure ??= this.asError(error);
      warnOnce(
        "batch:export",
        "fancy.recordBatchResult() export failed; recording and flush operations will reject",
      );
      throw this.failure;
    }
  }
}
