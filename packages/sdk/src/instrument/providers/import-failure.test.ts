import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The OpenLLMetry packages are optional peers, so a tree without one — or with
 * one that throws while loading — has to degrade to "attribution but no
 * spans". The failure is reported once and never again, because the same
 * missing package would otherwise be announced per instrumented client.
 */
describe("an instrumentation package that cannot be imported", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@traceloop/instrumentation-openai");
    vi.resetModules();
  });

  it("resolves false and warns once", async () => {
    vi.resetModules();
    vi.doMock("@traceloop/instrumentation-openai", () => {
      throw new Error("Cannot find module '@traceloop/instrumentation-openai'");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Imported after the mock is registered, and with a module registry reset
    // around it, so this module graph — the adapter and the warning budget it
    // shares — is the mocked one and nothing outside this file sees it.
    const { patchOpenAIClass } = await import("./openai.js");
    const opts = { tracerProvider: trace.getTracerProvider(), traceContent: true };

    expect(await patchOpenAIClass(class Fake {}, opts)).toBe(false);
    expect(await patchOpenAIClass(class Fake {}, opts)).toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/@traceloop\/instrumentation-openai/);
  });
});
