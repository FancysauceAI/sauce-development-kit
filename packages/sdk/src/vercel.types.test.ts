import type { TelemetryOptions } from "ai";
import { describe, expectTypeOf, it } from "vitest";
import type { VercelTelemetry } from "./vercel-telemetry.js";

// `ai` is a devDependency and imported for its types only, so the AI SDK stays
// out of the published runtime graph while the structural declaration of
// VercelTelemetry still fails the build if the AI SDK renames or retypes a
// field this package sets.
describe("VercelTelemetry", () => {
  it("is what the Vercel AI SDK accepts as its telemetry option", () => {
    // v7 names the type TelemetryOptions and drops `tracer`, which it ignores
    // in favour of the global tracer provider; v4/v5 name it TelemetrySettings
    // and read `tracer`. The extra field is why this is assignability and not
    // equality.
    expectTypeOf<VercelTelemetry>().toExtend<TelemetryOptions>();
  });
});
