# Releasing kompensa

Releases are **tag-driven**. Pushing a `v*.*.*` tag triggers
`.github/workflows/release.yml`, which validates, tests, builds, publishes
to npm with provenance, and creates a GitHub Release from the matching
`CHANGELOG.md` section.

You should never run `npm publish` manually for routine releases.

## Prerequisites (one-time)

1. **`NPM_TOKEN`** must exist in `Settings → Secrets and variables → Actions`.
   Use an **automation token** with `publish` scope (not a user token), and
   keep npm 2FA on `auth-and-writes` so token-based CI publish keeps working.
2. The `id-token: write` and `contents: write` permissions are already set in
   the workflow — these enable npm `--provenance` and GitHub Release creation.

## Standard release flow

1. **Make sure `main` is green.** All work for the release is merged and the
   regular `ci.yml` is passing.
2. **Add a CHANGELOG entry** for the new version. Heading must be exactly
   `## [X.Y.Z] — YYYY-MM-DD` so the workflow can extract release notes.
3. **Bump the version**:

   ```bash
   npm run release:patch    # 0.2.1 → 0.2.2
   npm run release:minor    # 0.2.x → 0.3.0
   npm run release:major    # 0.x.y → 1.0.0
   ```

   Each script runs `npm version <bump>` (which updates `package.json`,
   creates a commit, and creates the matching `vX.Y.Z` tag) then pushes
   the commit and tag together with `--follow-tags`.
4. **Watch the run** in the *Actions* tab. The pipeline runs four jobs:
   - `verify` — fails fast if the tag doesn't match `package.json.version`.
   - `unit` — matrix Node 18/20/22, typecheck + build + tests.
   - `integration` — Postgres 17 + Redis 7 services, three retry attempts.
   - `publish` — `npm publish --provenance --access public` then creates the
     GitHub Release with the CHANGELOG section as body.
5. **Verify the published artifact**:

   ```bash
   npm view kompensa@<version>
   npm install kompensa@<version> --dry-run
   ```

   Check the GitHub Release page and the `Provenance` badge on the npm page.

## When the pipeline fails

The most common failures and their fixes:

- **Tag/version mismatch** (`verify` job): the tag was pushed but the
  `package.json` change was forgotten. Delete the tag locally and remotely,
  fix `package.json`, retry:

  ```bash
  git tag -d vX.Y.Z
  git push --delete origin vX.Y.Z
  # fix package.json, commit, then re-run the bump
  ```
- **Tests fail on a Node version not in `ci.yml`**: bump matrix in `ci.yml`
  to keep parity with `release.yml`. Don't lower coverage to ship.
- **Integration retry exhausted**: usually flaky service startup. Re-run the
  failed `integration` job from the *Actions* page; nothing else needs to
  change. The downstream `publish` job re-runs automatically.
- **`npm publish` 403 / OTP**: token expired or scope wrong. Generate a new
  automation token, update `NPM_TOKEN` secret, re-run the failed job.
- **Pre-publish blocked locally**: `prepublishOnly` runs typecheck + tests +
  build. If you're trying to publish manually, fix the underlying error
  rather than bypassing the script.

## Pre-1.0 versioning rules

- Patch (`0.2.x`): fixes, docs, dep bumps, additive type-only changes.
- Minor (`0.x.0`): new features that are **additive**. Backwards-compatible
  with prior `0.x` consumers — no removal, rename, or behavior change of
  existing public API.
- Major (`1.0.0`): API freeze. Until then, treat any breaking change as
  reason to delay the release rather than ship it.

The current public surface is fixed in `llms.txt` and `AGENTS.md`. Adding
to it is allowed; removing or renaming requires a major bump.

## What gets published to npm

Only the files listed under `package.json#files`:

```
dist/
README.md
LICENSE
CHANGELOG.md
```

Anything else (`src/`, `test/`, `.github/`, `docs/`, `node_modules/`, etc.)
stays out of the tarball. Run `npm pack --dry-run` locally to inspect what
would be published.
