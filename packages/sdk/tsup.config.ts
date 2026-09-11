import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", contract: "src/contract.ts", vercel: "src/vercel.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  external: ["@traceloop/instrumentation-openai", "@traceloop/instrumentation-anthropic"],
  define: { __SDK_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0") },
});
