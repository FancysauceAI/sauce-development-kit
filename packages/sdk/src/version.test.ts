import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./version.js";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("SDK_VERSION", () => {
  it("is the package version when the build define is present", () => {
    expect(SDK_VERSION).toBe(PACKAGE_VERSION);
  });

  it("resolves to a version string when the SDK is loaded as source", () => {
    // The define exists only in the tsup and vitest configurations, so this
    // runs the module the way a consumer mapped onto src/ does — through a
    // TypeScript loader, with no substitution — where reading the identifier
    // bare throws a ReferenceError.
    const url = new URL("./version.ts", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "-e",
        `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.SDK_VERSION))`,
      ],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });
});
