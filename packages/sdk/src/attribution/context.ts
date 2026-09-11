import { AsyncLocalStorage } from "node:async_hooks";
import { debug, warnOnce } from "../diagnostics.js";
import { normalizeBag, normalizeMetadata, type BagInput, type DroppedKey } from "./normalize.js";

export interface Scope {
  attribution: Record<string, string>;
  metadata: Record<string, string>;
  reserved: Record<string, string>;
}

export interface AttributeOptions {
  metadata?: BagInput;
}

export type ContextMode = "auto" | "global";

const EMPTY: Scope = Object.freeze({ attribution: {}, metadata: {}, reserved: {} });

function reportDrops(dropped: DroppedKey[]): void {
  for (const d of dropped)
    warnOnce(`drop:${d.key}`, `attribution key "${d.rawKey}" dropped (${d.reason})`);
}

function merge(base: Scope, bag: BagInput, opts?: AttributeOptions): Scope {
  const n = normalizeBag(bag);
  const m = opts?.metadata
    ? normalizeMetadata(opts.metadata)
    : { metadata: {}, dropped: [] as DroppedKey[] };
  reportDrops([...n.dropped, ...m.dropped]);
  return {
    attribution: { ...base.attribution, ...n.attribution },
    metadata: { ...base.metadata, ...m.metadata },
    reserved: { ...base.reserved, ...n.reserved },
  };
}

/** The closure form, which is the only form that cannot leak between flows. */
interface AttributeCall {
  <T>(bag: BagInput, fn: () => T): T;
  <T>(bag: BagInput, opts: AttributeOptions, fn: () => T): T;
}

export interface AttributeFn extends AttributeCall {
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
 */
export class AttributionContext {
  private readonly als: AsyncLocalStorage<Scope> | null;
  private global: Scope = EMPTY;
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
      end: (key?: string): void => this.enter(key ? this.without(key) : EMPTY),
    });
  }

  current(): Scope {
    return this.als?.getStore() ?? this.global;
  }

  private run<T>(bag: BagInput, optsOrFn: AttributeOptions | (() => T), maybeFn?: () => T): T {
    const fn = typeof optsOrFn === "function" ? optsOrFn : (maybeFn as () => T);
    const opts = typeof optsOrFn === "function" ? undefined : optsOrFn;
    const next = merge(this.current(), bag, opts);
    debug("attribute", next);
    if (this.als) return this.als.run(next, fn);
    // Global mode has no async isolation to lean on, so the previous scope is
    // restored by hand — after the promise settles when the callback is async.
    const prev = this.global;
    this.global = next;
    const restore = (): void => {
      this.global = prev;
    };
    try {
      const out = fn();
      if (out instanceof Promise) return out.finally(restore) as T;
      restore();
      return out;
    } catch (e) {
      restore();
      throw e;
    }
  }

  private enter(scope: Scope): void {
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
    return {
      ...cur,
      attribution: Object.fromEntries(Object.entries(cur.attribution).filter(([x]) => x !== k)),
    };
  }
}
