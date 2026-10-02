import { createSdk } from "./init.js";

// One SDK per process, because what it owns — the global tracer provider, the
// context manager, the attribution scope — is process-wide. Tests that need a
// second one construct it through the internal factory.
//
// It lives in its own module so the `./vercel` subpath entry can bind to the
// same instance the `fancy` object wraps, without either entry importing the
// other.
export const sdk = createSdk();
