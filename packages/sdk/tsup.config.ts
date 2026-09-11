import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The published version is the one in package.json, read here rather than from
// npm_package_version, which is set only when the build runs through npm/pnpm
// scripts and silently becomes "0.0.0" when it does not.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: { index: "src/index.ts", contract: "src/contract.ts", vercel: "src/vercel.ts" },
  format: ["esm", "cjs"],
  // On for CJS as well as ESM, where it is the default. The `.` and `./vercel`
  // entries share the one process SDK, and without splitting each CJS entry
  // bundles its own copy of it: `require()`ing both would hand out two SDKs,
  // and the one behind the subpath would never see init().
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  external: ["@traceloop/instrumentation-openai", "@traceloop/instrumentation-anthropic"],
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
