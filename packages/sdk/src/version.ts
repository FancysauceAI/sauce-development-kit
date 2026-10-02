/**
 * The SDK version stamped on the exported resource.
 *
 * The build (and the test runner) substitute `__SDK_VERSION__` with the
 * version in package.json. Nothing substitutes it when the SDK is consumed as
 * source — a tsconfig `paths` mapping onto `src/`, a TypeScript loader — so the
 * identifier is absent at runtime there and reading it bare throws a
 * ReferenceError before `init()` can build the resource.
 */
export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === "undefined" ? "0.0.0" : __SDK_VERSION__;
