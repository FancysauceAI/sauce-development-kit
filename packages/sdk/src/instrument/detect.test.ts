import { describe, expect, it } from "vitest";
import { detectProvider } from "./detect.js";

class Completions {
  create(): void {}
}
class Chat {
  completions = new Completions();
}
class FakeOpenAI {
  chat = new Chat();
}
class FakeResponsesOnly {
  responses = { create: (): void => {} };
}
class Messages {
  create(): void {}
}
class FakeAnthropic {
  messages = new Messages();
}
class AzureOpenAI extends FakeOpenAI {}

describe("detectProvider", () => {
  it("recognizes an OpenAI client by its chat.completions.create surface", () => {
    expect(detectProvider(new FakeOpenAI())).toBe("openai");
  });

  it("recognizes an OpenAI client that only exposes the responses API", () => {
    expect(detectProvider(new FakeResponsesOnly())).toBe("openai");
  });

  it("recognizes an Anthropic client by its messages.create surface", () => {
    expect(detectProvider(new FakeAnthropic())).toBe("anthropic");
  });

  it("recognizes a subclass, since the surface is inherited", () => {
    expect(detectProvider(new AzureOpenAI())).toBe("openai");
  });

  it("returns null for anything else", () => {
    expect(detectProvider({ query: () => undefined })).toBeNull();
    expect(detectProvider(null)).toBeNull();
    expect(detectProvider(undefined)).toBeNull();
    expect(detectProvider("openai")).toBeNull();
    // A bag whose `chat` is a string must not be walked into.
    expect(detectProvider({ chat: "completions.create" })).toBeNull();
  });
});
