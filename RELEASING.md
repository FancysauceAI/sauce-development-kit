# Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets). Nothing is published by hand.

## How a release happens

1. A pull request that changes a package adds a changeset (`pnpm changeset`) describing the change and its bump level.
2. The pull request merges to `main`.
3. The `Release` workflow opens (or updates) a release pull request titled `chore: release`. It applies every pending changeset: versions are bumped, changesets are consumed, and `CHANGELOG.md` is rewritten.
4. **Squash-merge** that release pull request. Branch protection requires signed commits and a linear history; GitHub signs the squash commit it creates, so squash-merge is the only merge that satisfies both.
5. The push of the squash commit runs `Release` again. This time there are no pending changesets, so the workflow runs `pnpm release` — build, test, then `changeset publish` — and the new versions go to npmjs as [`@fancysauce/sdk`](https://www.npmjs.com/package/@fancysauce/sdk), each with a provenance statement linking it to the workflow run that built it.

A release pull request with no packages to version is not opened; if nothing shows up after a merge, check that the change carried a changeset.

## Repository settings this depends on

The release pull request is opened with a GitHub App token rather than the workflow's own `GITHUB_TOKEN`, because events raised by `GITHUB_TOKEN` never start a workflow — a release pull request opened with it would sit with no CI run and could not satisfy branch protection.

Create a GitHub App with **contents: write** and **pull requests: write** repository permissions, install it on this repository, then configure:

| Kind                | Name                      | Value                                          |
| ------------------- | ------------------------- | ---------------------------------------------- |
| Repository variable | `RELEASE_APP_ID`          | The app's numeric App ID                       |
| Repository secret   | `RELEASE_APP_PRIVATE_KEY` | A private key generated for the app (full PEM) |

## Publishing credentials

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): the job's OIDC token (`id-token: write`) is exchanged for a short-lived publish credential, so no long-lived npm token sits in the repository. npmjs only lets a trusted publisher be configured on a package that already exists, so a package's first version goes out with a token instead:

1. Create a granular access token on npmjs with read and write access to the `@fancysauce` scope, and store it as the repository secret `NPM_TOKEN`.
2. Merge to `main`; `Release` publishes the first version with that token.
3. On the package's npmjs settings page, add a trusted publisher: GitHub Actions, repository `FancysauceAI/sauce-development-kit`, workflow `release.yml`, no environment. Under publishing access, require two-factor authentication and disallow tokens.
4. Delete the `NPM_TOKEN` secret and revoke the token. The workflow needs no change: npm tries trusted publishing before it reads a token.

A new package added to this repository repeats steps 1–4 for its first release.
