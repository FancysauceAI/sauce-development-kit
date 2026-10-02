import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Matches tsup.config.ts so the value the tests assert is the value the build
// ships.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // The contract suites and init.test.ts each register the global
    // OpenTelemetry tracer provider and context manager; sharing a worker
    // across files would let one file's init()/shutdown() race another's.
    isolate: true,
  },
});
