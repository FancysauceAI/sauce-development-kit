import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINT, resolveConfig } from "./config.js";
import { resetDiagnostics } from "./diagnostics.js";

describe("resolveConfig", () => {
  afterEach(() => {
    resetDiagnostics();
  });

  it("applies the defaults", () => {
    const cfg = resolveConfig({ apiKey: "fs_test_x" });
    expect(cfg.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(cfg.content).toBe("full");
    expect(cfg.context).toBe("auto");
    expect(cfg.registerContextManager).toBe(true);
    expect(cfg.debug).toBe(false);
    expect(cfg.attribution).toEqual({});
  });

  it("strips trailing slashes from the endpoint", () => {
    // `${endpoint}/v1/traces` is built by concatenation, so a trailing slash
    // would produce a double slash the ingest would not route.
    expect(resolveConfig({ apiKey: "fs_test_x", endpoint: "https://x.example/" }).endpoint).toBe(
      "https://x.example",
    );
    expect(resolveConfig({ apiKey: "fs_test_x", endpoint: "https://x.example///" }).endpoint).toBe(
      "https://x.example",
    );
  });

  it("warns once about a key that does not look like ours, and still resolves", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveConfig({ apiKey: "sk-other-vendor" }).apiKey).toBe("sk-other-vendor");
    resolveConfig({ apiKey: "sk-other-vendor" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fs_"));
    warn.mockRestore();
  });

  it("says nothing about a key with the expected prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveConfig({ apiKey: "fs_live_x" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
