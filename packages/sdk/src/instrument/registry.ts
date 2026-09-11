import { trace, type TracerProvider } from "@opentelemetry/api";
import type { AttributionContext } from "../attribution/context.js";
import type { BagInput } from "../attribution/normalize.js";
import { debug, warnOnce } from "../diagnostics.js";
import { detectProvider, type Provider } from "./detect.js";
import { ANTHROPIC_METHODS, patchAnthropicClass } from "./providers/anthropic.js";
import { OPENAI_METHODS, patchOpenAIClass } from "./providers/openai.js";

export interface InstrumentOptions {
  /** Attribution applied to every call on this client instance. */
  attribution?: BagInput;
}

interface RegistryDeps {
  /** Patches the class's prototypes; resolves false when the instrumentation package is absent. */
  patch?: (
    provider: Provider,
    ctor: unknown,
    tracerProvider: TracerProvider,
    traceContent: boolean,
  ) => Promise<boolean>;
  traceContent: boolean;
}

type Method = (...args: unknown[]) => unknown;

type Wrapper = Method & { [INSTRUMENTED]?: InstrumentedTag };

const METHODS: Record<Provider, readonly string[]> = {
  openai: OPENAI_METHODS,
  anthropic: ANTHROPIC_METHODS,
};

/** The per-call escape hatch, read out of whichever argument carries it. */
const OVERRIDE_KEY = "fancysauce";

/**
 * Marks a method this SDK wrapped, and holds the options that wrapper reads.
 * Registered globally (Symbol.for) so two copies of the SDK in one dependency
 * tree recognize each other's wrappers instead of stacking on them.
 */
const INSTRUMENTED = Symbol.for("fancysauce.instrumented");

/** The mutable options cell a wrapper reads at call time. */
interface InstrumentedTag {
  options: InstrumentOptions;
}

const SUPPORTED =
  "fancy.instrument(): unsupported client; supported: openai, anthropic " +
  "(the Vercel AI SDK is instrumented with fancy.vercelTelemetry())";

async function defaultPatch(
  provider: Provider,
  ctor: unknown,
  tracerProvider: TracerProvider,
  traceContent: boolean,
): Promise<boolean> {
  return provider === "openai"
    ? patchOpenAIClass(ctor, { tracerProvider, traceContent })
    : patchAnthropicClass(ctor, { tracerProvider, traceContent });
}

/** The object in the prototype chain that owns `key`, or null if nothing does. */
function ownerOf(target: object, key: string): object | null {
  let o: object | null = target;
  while (o !== null && !Object.prototype.hasOwnProperty.call(o, key))
    o = Object.getPrototypeOf(o) as object | null;
  return o;
}

/**
 * Lifts the per-call `fancysauce` option out of the arguments and returns the
 * arguments to forward without it. It is read from whichever argument carries
 * it — the request body for `create({ …, fancysauce })`, the request options
 * for a two-argument call — because that is where a caller naturally writes
 * it, and it is always removed: the provider SDK would either reject the
 * unknown field or forward it to the vendor.
 *
 * A value that is not a bag — a string, an array — is dropped with a warning
 * rather than normalized, because normalizing it would attribute the call to
 * keys the caller never wrote.
 */
function takeOverride(args: unknown[]): { override: BagInput; forwarded: unknown[] } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === null || typeof arg !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(arg, OVERRIDE_KEY)) continue;
    const { [OVERRIDE_KEY]: override, ...rest } = arg as Record<string, unknown>;
    const forwarded = args.slice();
    forwarded[i] = rest;
    // null and undefined are how a caller opts out of an override they built
    // conditionally, so only a wrong *kind* of value is worth a warning.
    if (override != null && (typeof override !== "object" || Array.isArray(override))) {
      warnOnce("instrument:override", "the per-call fancysauce option must be an object");
      return { override: {}, forwarded };
    }
    return { override: (override ?? {}) as BagInput, forwarded };
  }
  return { override: {}, forwarded: args };
}

/**
 * instrument(client): patch the client's class once (OpenLLMetry creates the
 * spans), then wrap the instance's known methods so each call runs inside the
 * client-bound defaults plus any per-call `fancysauce` override — the stamping
 * processor sees that scope when the span starts.
 *
 * The class patch is asynchronous, because the instrumentation package is
 * loaded on demand and only when a client of that provider shows up. Calls
 * made before it lands carry their attribution but produce no span, so
 * `instrument()` belongs in startup; `ready()` is there for a caller that
 * needs the guarantee rather than the convention.
 *
 * The patch lands on the class's prototypes, which every client of that class
 * shares. So instrumenting one client turns on span creation for every client
 * of that class in the process — including ones never passed to
 * `instrument()`. Only instrumented instances carry client-bound attribution;
 * spans from the others get whatever ambient scope is active plus the
 * `init()` defaults, and nothing else.
 */
export class InstrumentRegistry {
  private readonly patched = new WeakSet<object>();
  private readonly pending = new Set<Promise<void>>();
  private readonly patch: NonNullable<RegistryDeps["patch"]>;

  constructor(
    readonly ctx: AttributionContext,
    private readonly deps: RegistryDeps,
  ) {
    this.patch = deps.patch ?? defaultPatch;
  }

  /** Resolves once every class patch started so far has settled. */
  async ready(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  instrument<T extends object>(client: T, opts: InstrumentOptions = {}): T {
    const provider = detectProvider(client);
    if (!provider) throw new Error(SUPPORTED);
    const ctor = (client as { constructor?: unknown }).constructor;
    // Keyed on the constructor, so N clients of one class patch once. Two
    // subclasses sharing a prototype do reach the patch twice; that is safe
    // because OpenTelemetry's _wrap unwraps an already-wrapped method first.
    if (typeof ctor === "function" && !this.patched.has(ctor)) {
      this.patched.add(ctor);
      const done = this.patch(provider, ctor, trace.getTracerProvider(), this.deps.traceContent)
        .then((ok) => {
          // A patch that did not take is forgotten, so the next instrument()
          // for this class tries again. The alternative marks a class patched
          // on a transient import failure and never creates a span for it
          // again, for the life of the process.
          if (!ok) this.patched.delete(ctor);
          debug(`instrument: ${provider} class patched`, ok);
        })
        .catch((error: unknown) => {
          this.patched.delete(ctor);
          // A client that cannot be patched still carries attribution on
          // whatever spans the host creates around it, so this is a warning
          // and not a throw: instrument() must not take the application down.
          warnOnce(
            `instrument:patch:${provider}`,
            `fancy.instrument(): could not instrument the ${provider} client; its calls will carry attribution but produce no spans`,
          );
          debug("instrument: patch failed", error);
        })
        .finally(() => {
          this.pending.delete(done);
        });
      this.pending.add(done);
    }
    for (const path of METHODS[provider]) this.wrap(client, path, opts);
    return client;
  }

  private wrap(client: object, path: string, opts: InstrumentOptions): void {
    const parts = path.split(".");
    const method = parts.pop() as string;
    const target = parts.reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      client,
    ) as Record<string, unknown> | undefined;
    if (!target || typeof target[method] !== "function") return;
    // A second instrument() on the same client replaces the options its
    // wrapper reads. Wrapping again would open one attribution scope per
    // instrument() call, and the outer ones would keep applying options the
    // caller has already replaced.
    const existing = Object.prototype.hasOwnProperty.call(target, method)
      ? (target[method] as Wrapper)[INSTRUMENTED]
      : undefined;
    if (existing) {
      existing.options = opts;
      return;
    }
    const captured = target[method] as Method;
    const owner = ownerOf(target, method);
    // The class patch replaces the method where it lives, and it does so after
    // this runs. So the method is resolved per call rather than captured: an
    // own property here shadows the prototype, and a captured value would pin
    // this client to the unpatched function for the life of the process. When
    // the method is the instance's own, our definition replaces it and the
    // captured value is the only way back.
    const resolve: () => Method =
      owner !== null && owner !== target
        ? () => {
            const current = (owner as Record<string, unknown>)[method];
            return typeof current === "function" ? (current as Method) : captured;
          }
        : () => captured;
    const ctx = this.ctx;
    const tag: InstrumentedTag = { options: opts };
    const wrapper: Wrapper = Object.assign(
      function (this: unknown, ...args: unknown[]): unknown {
        const { override, forwarded } = takeOverride(args);
        return ctx.attribute({ ...tag.options.attribution, ...override }, () =>
          resolve().apply(this ?? target, forwarded),
        );
      },
      { [INSTRUMENTED]: tag },
    );
    try {
      Object.defineProperty(target, method, {
        configurable: true,
        writable: true,
        value: wrapper,
      });
    } catch (error) {
      warnOnce(
        `instrument:wrap:${path}`,
        `fancy.instrument(): could not wrap ${path}; calls through it will not be attributed`,
      );
      debug("instrument: wrap failed", error);
    }
  }
}
