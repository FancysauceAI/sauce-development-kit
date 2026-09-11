import { warnOnce } from "../../diagnostics.js";
import type { PatchOptions } from "./types.js";

/**
 * The instance methods `instrument()` wraps so each call runs inside the
 * client's attribution scope. `stream()` is here for the scope, not for a
 * span: OpenLLMetry spans `messages.create`, which `stream()` reaches
 * internally, and wrapping `stream()` is what keeps that inner call inside the
 * caller's attribution.
 */
export const ANTHROPIC_METHODS = ["messages.create", "messages.stream"] as const;

/**
 * Patches the Anthropic client class's prototypes through OpenLLMetry, and
 * resolves false when that package is not installed.
 *
 * The patch is class-wide, because prototypes are: once one client of this
 * class has been instrumented, every client of it in the process produces
 * spans, whether or not it was passed to `instrument()`. Only instrumented
 * instances carry client-bound attribution; the rest are stamped with the
 * ambient scope and the `init()` defaults.
 *
 * Unlike the OpenAI instrumentation, this one's `manuallyInstrument()` reads
 * `Completions`, `Messages` and `Beta.Messages` from under an `.Anthropic`
 * key, exactly as its module-load path does — so the class is wrapped in that
 * one-key object. The Anthropic SDK exposes all three as statics on the client
 * class, which is what lets the class stand in for the module namespace.
 *
 * Calling this twice for the same class is safe: OpenTelemetry's `_wrap`
 * unwraps a method that is already wrapped before wrapping it again.
 */
export async function patchAnthropicClass(ctor: unknown, opts: PatchOptions): Promise<boolean> {
  let mod: typeof import("@traceloop/instrumentation-anthropic");
  try {
    mod = await import("@traceloop/instrumentation-anthropic");
  } catch {
    warnOnce(
      "instrument:anthropic",
      "fancy.instrument(): install @traceloop/instrumentation-anthropic to instrument Anthropic clients",
    );
    return false;
  }
  const inst = new mod.AnthropicInstrumentation({
    // See the note in ./openai.ts: this keeps the constructor from registering
    // a global require hook.
    enabled: false,
    traceContent: opts.traceContent,
  });
  inst.setTracerProvider(opts.tracerProvider);
  // See the note in ./openai.ts: recorded before the patch, because a span can
  // exist as soon as the prototypes are wrapped.
  opts.allowScope(inst.instrumentationName);
  // The parameter is declared as the whole module namespace, but the body
  // reads only `.Anthropic` and the statics under it, so the cast is over the
  // type and not over anything the call touches.
  inst.manuallyInstrument({ Anthropic: ctor } as never);
  return true;
}
