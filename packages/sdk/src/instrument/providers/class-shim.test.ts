/* eslint-disable @typescript-eslint/unbound-method -- the point of this suite
   is to inspect the method *values* on the SDK prototypes, never to call them. */
import { trace } from "@opentelemetry/api";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { patchAnthropicClass } from "./anthropic.js";
import { patchOpenAIClass } from "./openai.js";

/**
 * The adapters hand OpenLLMetry the client class where it expects a module
 * namespace. That works only while the real SDKs keep exposing their
 * sub-resource classes as statics, and a missing one is an unguarded
 * dereference inside OpenLLMetry rather than a graceful skip — so the shape is
 * pinned here, against the installed SDKs. Spans are Task 12's subject; this
 * asserts only that the prototypes the instrumentation aims at were reached.
 */
const wrapped = (f: unknown): boolean =>
  typeof f === "function" && (f as { __wrapped?: boolean }).__wrapped === true;

describe("the client class as a stand-in for the module namespace", () => {
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
