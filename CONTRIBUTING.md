# Contributing

- Open an issue before a large change; small fixes can go straight to a PR.
- `pnpm install && pnpm test` must pass. CI runs lint, typecheck, tests on Node 22 and 24, and an internal-reference check.
- Commits are scanned for secrets by a [gitleaks](https://github.com/gitleaks/gitleaks#installing) pre-commit hook (`brew install gitleaks` on macOS), which `pnpm install` wires up through husky; the commit fails if `gitleaks` is not installed. CI scans every push and pull request as well. Configuration lives in `.gitleaks.toml`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org). Every user-facing change adds a changeset (`pnpm changeset`).
- Comments explain what and why. Do not reference internal ticketing systems, private documents, or people — this repository is written for a stranger.
- The root `tsconfig.json` exists so typed linting has a project root; packages extend `tsconfig.base.json`.
- `packages/sdk/test/contract/*.contract.test.ts` compare against recorded OTLP fixtures in `test/contract/out/`; re-record with `RECORD_CONTRACT=1 pnpm --filter @fancysauce/sdk test` after an intentional wire-shape change (e.g. bumping a `@traceloop/instrumentation-*` package).
