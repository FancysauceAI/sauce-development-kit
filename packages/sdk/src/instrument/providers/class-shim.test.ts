/* eslint-disable @typescript-eslint/unbound-method -- the point of this suite
   is to inspect the method *values* on the SDK prototypes, never to call them. */
import { trace } from "@opentelemetry/api";
import { isWrapped } from "@opentelemetry/instrumentation";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, describe, expect, it } from "vitest";
import { patchAnthropicClass } from "./anthropic.js";
import { patchOpenAIClass } from "./openai.js";

/**
 * The adapters hand OpenLLMetry the client class where it expects a module
 * namespace. That works only while the real SDKs keep exposing their
 * sub-resource classes as statics, and a missing one is an unguarded
 * dereference inside OpenLLMetry rather than a graceful skip for
 * `Chat.Completions` and `Completions` on the OpenAI side and for all three of
 * `Completions`, `Messages` and `Beta.Messages` on the Anthropic one.
 * (`Responses` and `Images` are the two OpenLLMetry does guard.) So the shape
 * is pinned here, against the installed SDKs. This asserts only that the
 * prototypes the instrumentation aims at were reached, not what the spans say.
 */
const wrapped = (f: unknown): boolean =>
  typeof f === "function" && (f as { __wrapped?: boolean }).__wrapped === true;

/** Restores one or more methods this suite's patches wrapped. */
function unwrap(owner: { prototype: object } | undefined, ...methods: string[]): void {
  for (const method of methods) {
    const fn = (owner?.prototype as Record<string, unknown> | undefined)?.[method];
    if (isWrapped(fn)) (fn.__unwrap as () => void)();
  }
}

describe("the client class as a stand-in for the module namespace", () => {
  // The patches land on the real SDK prototypes, which belong to the process
  // and not to this file. Every suite that loads either SDK afterwards would
  // otherwise be running against instrumented clients it never asked for.
  afterAll(() => {
    unwrap(OpenAI.Chat.Completions, "create");
    unwrap(OpenAI.Completions, "create");
    unwrap(OpenAI.Responses, "create");
    unwrap(OpenAI.Images, "generate", "edit", "createVariation");
    unwrap(Anthropic.Completions, "create");
    unwrap(Anthropic.Messages, "create");
    unwrap(Anthropic.Beta.Messages, "create");
  });

  it("reaches the OpenAI prototypes, and the instance reads them", async () => {
    expect(
      await patchOpenAIClass(OpenAI, {
        tracerProvider: trace.getTracerProvider(),
        traceContent: true,
      }),
    ).toBe(true);
    expect(wrapped(OpenAI.Chat.Completions.prototype.create)).toBe(true);
    expect(wrapped(OpenAI.Completions.prototype.create)).toBe(true);
    expect(wrapped(OpenAI.Responses.prototype.create)).toBe(true);
    expect(wrapped(new OpenAI({ apiKey: "fake" }).chat.completions.create)).toBe(true);
  });

  it("reaches the Anthropic prototypes, and the instance reads them", async () => {
    expect(
      await patchAnthropicClass(Anthropic, {
        tracerProvider: trace.getTracerProvider(),
        traceContent: true,
      }),
    ).toBe(true);
    expect(wrapped(Anthropic.Messages.prototype.create)).toBe(true);
    expect(wrapped(Anthropic.Completions.prototype.create)).toBe(true);
    expect(wrapped(Anthropic.Beta.Messages.prototype.create)).toBe(true);
    expect(wrapped(new Anthropic({ apiKey: "fake" }).messages.create)).toBe(true);
  });
});
