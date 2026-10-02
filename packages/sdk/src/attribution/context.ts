import { AsyncLocalStorage } from "node:async_hooks";
import { debug, warnOnce } from "../diagnostics.js";
import {
  isReserved,
  normalizeBag,
  normalizeMetadata,
  type BagInput,
  type DroppedKey,
  type ReservedBag,
} from "./normalize.js";

export interface Scope {
  attribution: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, string>>;
  /**
   * Reserved keys as written. They are expanded into standard attributes at
   * stamping time so that merging replaces a reserved key outright rather than
   * unioning the two attributes it can map to.
   */
  reserved: Readonly<ReservedBag>;
}

export interface AttributeOptions {
  metadata?: BagInput;
}

export type ContextMode = "auto" | "global";

// Every flow with no scope of its own is handed this one object, so the inner
// bags are frozen too: a caller that writes to what current() returned would
// otherwise be writing into every other flow's empty scope.
export const EMPTY_SCOPE: Scope = Object.freeze({
  attribution: Object.freeze({}),
  metadata: Object.freeze({}),
  reserved: Object.freeze({}),
});

export type BagKind = "attribution" | "metadata";

// The warning quotes the key as the caller wrote it; the dedupe key uses the
// normalized form, capped, because that is what the caller can act on and the
// budget is counted in distinct keys.
export function reportDrops(dropped: DroppedKey[], kind: BagKind): void {
  for (const d of dropped)
    warnOnce(
      `${kind}:${d.reason}:${d.key.slice(0, 64)}`,
      `${kind} key "${d.rawKey}" dropped (${d.reason})`,
    );
}

function merge(base: Scope, bag: BagInput, opts?: AttributeOptions): Scope {
  const n = normalizeBag(bag);
  const m = opts?.metadata
    ? normalizeMetadata(opts.metadata)
    : { metadata: {}, dropped: [] as DroppedKey[] };
  reportDrops(n.dropped, "attribution");
  reportDrops(m.dropped, "metadata");
  return {
    attribution: { ...base.attribution, ...n.attribution },
    metadata: { ...base.metadata, ...m.metadata },
    reserved: { ...base.reserved, ...n.reserved },
  };
}

// debug() writes to the host's logs, where an attribution, metadata or reserved
// value — a customer id, an email address, a ticket number — does not belong.
// Only the key names travel; the reason a key was dropped is reported
// separately, by reportDrops().
function scopeShape(scope: Scope): Record<string, string[]> {
  return {
    attribution: Object.keys(scope.attribution),
    metadata: Object.keys(scope.metadata),
    reserved: Object.keys(scope.reserved),
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** The closure form, which is the only form that cannot leak between flows. */
interface AttributeCall {
  <T>(bag: BagInput, fn: () => T): T;
  <T>(bag: BagInput, opts: AttributeOptions, fn: () => T): T;
}

export interface AttributeFn extends AttributeCall {
  /**
   * `start()` binds the current synchronous execution context and every
   * continuation created from it afterwards — the function you call it in,
   * everything it awaits later, and, if called before that function's first
   * `await`, the caller too. `end()` follows the same rule. Call them at a
   * request or job boundary; when several flows share a process, prefer the
   * closure form, which cannot leak.
   */
  start(bag: BagInput, opts?: AttributeOptions): void;
  add(bag: BagInput, opts?: AttributeOptions): void;
  /** Removes one attribution key, or the whole scope when called with none. */
  end(key?: string): void;
}

/**
 * Holds the active attribution scope for the current async flow. Lives in the
 * SDK's own AsyncLocalStorage — never in OTel context — because start()/end()
 * need enterWith(), which OTel's context API does not expose. Both propagate
 * through the same async_hooks continuation, so a span created inside a scope
 * always sees it in onStart. "global" mode is declared single-flow (scripts,
 * batch jobs): one process-wide bag, no async isolation, no warnings.
 *
 * `start()` binds the current synchronous execution context and every
 * continuation created from it afterwards — the function you call it in,
 * everything it awaits later, and, if called before that function's first
 * `await`, the caller too. `end()` follows the same rule. Call them at a
 * request or job boundary; when several flows share a process, prefer the
 * closure form, which cannot leak.
 */
export class AttributionContext {
  private readonly als: AsyncLocalStorage<Scope> | null;
  private global: Scope = EMPTY_SCOPE;
  readonly mode: ContextMode;
  readonly attribute: AttributeFn;

  constructor(opts: { mode: ContextMode }) {
    this.mode = opts.mode;
    this.als = opts.mode === "global" ? null : new AsyncLocalStorage<Scope>();
    const run: AttributeCall = <T>(
      bag: BagInput,
      optsOrFn: AttributeOptions | (() => T),
      maybeFn?: () => T,
    ): T => this.run(bag, optsOrFn, maybeFn);
    this.attribute = Object.assign(run, {
      start: (bag: BagInput, o?: AttributeOptions): void =>
        this.enter(merge(this.current(), bag, o)),
      add: (bag: BagInput, o?: AttributeOptions): void => this.enter(merge(this.current(), bag, o)),
      end: (key?: string): void => this.enter(key ? this.without(key) : EMPTY_SCOPE),
    });
  }

  current(): Scope {
    return this.als?.getStore() ?? this.global;
  }

  private run<T>(bag: BagInput, optsOrFn: AttributeOptions | (() => T), maybeFn?: () => T): T {
    const fn = typeof optsOrFn === "function" ? optsOrFn : (maybeFn as () => T);
    const opts = typeof optsOrFn === "function" ? undefined : optsOrFn;
    if (typeof fn !== "function")
      throw new TypeError("fancy.attribute(bag[, options], fn) requires a callback");
    const next = merge(this.current(), bag, opts);
    debug("attribute", scopeShape(next));
    if (this.als) return this.als.run(next, fn);
    // Global mode has no async isolation to lean on, so the previous scope is
    // restored by hand — after the promise settles when the callback is async.
    const prev = this.global;
    this.global = next;
    const restore = (): void => {
      if (this.global !== next)
        debug(
          "global scope changed during attribute(); global mode is single-flow; the scope set inside has been discarded",
        );
      this.global = prev;
    };
    try {
      const out = fn();
      // Anything with a then() is awaited, not just a native promise: the
      // callback may return a library's own thenable and the scope has to
      // outlive it either way. Promise.resolve() adopts it, so what the caller
      // gets back is a native promise, not the thenable it returned.
      if (isThenable(out)) return Promise.resolve(out).finally(restore) as T;
      restore();
      return out;
    } catch (e) {
      restore();
      throw e;
    }
  }

  private enter(scope: Scope): void {
    debug("attribute.start", scopeShape(scope));
    if (!this.als) {
      this.global = scope;
      return;
    }
    if (typeof (this.als as { enterWith?: unknown }).enterWith !== "function") {
      throw new Error(
        "fancy.attribute.start() needs AsyncLocalStorage.enterWith(), which this runtime lacks; use the closure form fancy.attribute(bag, fn) or a per-call override",
      );
    }
    this.als.enterWith(scope);
  }

  private without(key: string): Scope {
    const cur = this.current();
    const k = key.trim().toLowerCase();
    const kept = Object.entries(cur.attribution).filter(([x]) => x !== k);
    if (kept.length === Object.keys(cur.attribution).length)
      debug(
        isReserved(k)
          ? "attribute.end: a reserved key is not an attribution key and end(key) cannot remove it; end() drops the whole scope"
          : "attribute.end: no such attribution key",
        key,
      );
    return { ...cur, attribution: Object.fromEntries(kept) };
  }
}
