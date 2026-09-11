import type { TracerProvider } from "@opentelemetry/api";
import { warnOnce } from "../../diagnostics.js";

/**
 * The instance methods `instrument()` wraps so each call runs inside the
 * client's attribution scope. OpenLLMetry creates the spans from the class
 * patch; this list only decides which calls carry attribution. `embeddings` is
 * here even though OpenLLMetry does not span it, so a host that spans its own
 * embedding calls still gets them attributed.
 */
export const OPENAI_METHODS = [
  "chat.completions.create",
  "responses.create",
  "embeddings.create",
] as const;

export interface PatchOptions {
  tracerProvider: TracerProvider;
  traceContent: boolean;
}

/**
 * Patches the OpenAI client class's prototypes through OpenLLMetry, and
 * resolves false when that package is not installed.
 *
 * The patch is class-wide, because prototypes are: once one client of this
 * class has been instrumented, every client of it in the process produces
 * spans, whether or not it was passed to `instrument()`. Only instrumented
 * instances carry client-bound attribution; the rest are stamped with the
 * ambient scope and the `init()` defaults.
 *
 * OpenLLMetry reaches the prototypes through a module namespace. Its
 * `manuallyInstrument()` reads `Chat.Completions`, `Completions`, `Responses`
 * and `Images` directly off what it is handed — the shape of the `OpenAI`
 * class itself, not of the module, which its module-load path reads the same
 * names from under `.OpenAI`. So the client's constructor is passed as-is.
 *
 * Calling this twice for the same class is safe: OpenTelemetry's `_wrap`
 * unwraps a method that is already wrapped before wrapping it again.
 */
export async function patchOpenAIClass(ctor: unknown, opts: PatchOptions): Promise<boolean> {
  let mod: typeof import("@traceloop/instrumentation-openai");
  try {
    mod = await import("@traceloop/instrumentation-openai");
  } catch {
    warnOnce(
      "instrument:openai",
      "fancy.instrument(): install @traceloop/instrumentation-openai to instrument OpenAI clients",
    );
    return false;
  }
  const inst = new mod.OpenAIInstrumentation({
    // `enabled: false` is what keeps the constructor from registering a global
    // require hook. instrument(client) is the explicit path: it patches the
    // class it was handed and nothing else. manuallyInstrument() does not
    // consult this flag, and neither does the wrapper it installs.
    enabled: false,
    traceContent: opts.traceContent,
    // Token counts come from the provider's response. Recomputing the missing
    // ones means loading a tokenizer and encoding every prompt, which is the
    // kind of cost a telemetry SDK must not impose by default.
    enrichTokens: false,
  });
  inst.setTracerProvider(opts.tracerProvider);
  inst.manuallyInstrument(ctor);
  return true;
}
