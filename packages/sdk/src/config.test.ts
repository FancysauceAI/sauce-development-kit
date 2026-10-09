import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { resetDiagnostics } from "./diagnostics.js";

describe("resolveConfig", () => {
  afterEach(() => {
    resetDiagnostics();
  });

  it("applies the defaults", () => {
    const cfg = resolveConfig({ apiKey: "fs_test_x" });
    expect(cfg.endpoint).toBe("https://ingest.preview.fancysauce.ai");
    expect(cfg.content).toBe("full");
    expect(cfg.context).toBe("auto");
    expect(cfg.registerContextManager).toBe(true);
    expect(cfg.debug).toBe(false);
    expect(cfg.attribution).toEqual({});
  });

  it("strips trailing slashes from the endpoint", () => {
    // The exporter appends `/v1/traces` to the endpoint's path, so a trailing
    // slash would leave an empty path segment the ingest would not route.
    expect(resolveConfig({ apiKey: "fs_test_x", endpoint: "https://x.example/" }).endpoint).toBe(
      "https://x.example",
    );
    expect(resolveConfig({ apiKey: "fs_test_x", endpoint: "https://x.example///" }).endpoint).toBe(
      "https://x.example",
    );
  });

  it("rejects an endpoint that is not an http(s) URL", () => {
    for (const endpoint of ["ingest.example", "ftp://x.example", "https://"])
      expect(() => resolveConfig({ apiKey: "fs_test_x", endpoint }), endpoint).toThrow(
        /http\(s\) URL/,
      );
  });

  it("accepts plain http only for a loopback host", () => {
    for (const endpoint of ["http://localhost:4318", "http://127.0.0.1:4318", "http://[::1]:4318"])
      expect(resolveConfig({ apiKey: "fs_test_x", endpoint }).endpoint, endpoint).toBe(endpoint);
    // A hostname that merely starts with a loopback address is somebody else's
    // machine, and the key and the prompts would reach it unencrypted.
    for (const endpoint of ["http://ingest.example", "http://127.0.0.1.example.com"])
      expect(() => resolveConfig({ apiKey: "fs_test_x", endpoint }), endpoint).toThrow(
        /loopback host/,
      );
  });

  it("rejects an endpoint carrying a query string or a fragment", () => {
    for (const endpoint of ["https://x.example?token=x", "https://x.example/base#f"])
      expect(() => resolveConfig({ apiKey: "fs_test_x", endpoint }), endpoint).toThrow(
        /query string or fragment/,
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
