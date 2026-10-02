# Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets). Nothing is published by hand.

## How a release happens

1. A pull request that changes a package adds a changeset (`pnpm changeset`) describing the change and its bump level.
2. The pull request merges to `main`.
3. The `Release` workflow opens (or updates) a release pull request titled `chore: release`. It applies every pending changeset: versions are bumped, changesets are consumed, and `CHANGELOG.md` is rewritten.
4. **Squash-merge** that release pull request. Branch protection requires signed commits and a linear history; GitHub signs the squash commit it creates, so squash-merge is the only merge that satisfies both.
5. The push of the squash commit runs `Release` again. This time there are no pending changesets, so the workflow runs `pnpm release` — build, test, then `changeset publish` — and the new versions go to GitHub Packages.

A release pull request with no packages to version is not opened; if nothing shows up after a merge, check that the change carried a changeset.

## Repository settings this depends on

The release pull request is opened with a GitHub App token rather than the workflow's own `GITHUB_TOKEN`, because events raised by `GITHUB_TOKEN` never start a workflow — a release pull request opened with it would sit with no CI run and could not satisfy branch protection.

Create a GitHub App with **contents: write** and **pull requests: write** repository permissions, install it on this repository, then configure:

| Kind                | Name                      | Value                                          |
| ------------------- | ------------------------- | ---------------------------------------------- |
| Repository variable | `RELEASE_APP_ID`          | The app's numeric App ID                       |
| Repository secret   | `RELEASE_APP_PRIVATE_KEY` | A private key generated for the app (full PEM) |

Publishing itself uses the workflow's `GITHUB_TOKEN` (as `NODE_AUTH_TOKEN`), which the job grants `packages: write`.

## When this repository goes public

Two changes ship together:

- `.changeset/config.json`: `"access": "restricted"` becomes `"access": "public"`.
- The registry moves from GitHub Packages to npmjs — drop the `@fancysauce` registry line from `.npmrc`, point `registry-url` in the release workflow at `https://registry.npmjs.org`, and supply an npmjs publish token as `NODE_AUTH_TOKEN` instead of `GITHUB_TOKEN`.
