# Contributing

- Open an issue before a large change; small fixes can go straight to a PR.
- `pnpm install && pnpm test` must pass. CI runs lint, typecheck, tests on Node 22 and 24, and an internal-reference check.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org). Every user-facing change adds a changeset (`pnpm changeset`).
- Comments explain what and why. Do not reference internal ticketing systems, private documents, or people — this repository is written for a stranger.
- The root `tsconfig.json` exists so typed linting has a project root; packages extend `tsconfig.base.json`.
