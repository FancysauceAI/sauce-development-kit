import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0") },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node" },
});
