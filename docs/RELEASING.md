# Releasing altimate-code

This guide covers the complete release process for the altimate-code monorepo.

## Overview

The monorepo produces one publishable CLI package:

| Package | Registry | Trigger |
|---------|----------|---------|
| `@altimateai/altimate-code` | npm | `v*` tag (e.g., `v0.5.0`) |

The Python engine (`altimate-engine`) has been eliminated. All 73 tool methods run natively in TypeScript via `@altimateai/altimate-core` (napi-rs) and `@altimateai/drivers` (workspace package).

## Version Management

### CLI version (TypeScript)

The CLI version is determined automatically at build time:

- **Explicit**: Set `OPENCODE_VERSION=0.5.0` environment variable
- **Auto-bump**: Set `OPENCODE_BUMP=patch` (or `minor` / `major`) — fetches current version from npm and increments
- **Preview**: On non-main branches, generates `0.0.0-{branch}-{timestamp}`

The version is injected into the binary via esbuild defines at compile time.

### Dependency versions

| Dependency | Location | Managed by |
|------------|----------|------------|
| `@altimateai/altimate-core` | `packages/opencode/package.json` | altimate-core-internal repo |
| `@altimateai/drivers` | `packages/opencode/package.json` | workspace (this repo) |
| `@altimateai/dbt-integration` | `packages/dbt-tools/package.json` | separate npm package |

## Release Process

### 1. Run preflight (before touching anything)

**MANDATORY** — the deterministic gate. Run it while the tree is still clean;
it fails on a dirty worktree by design:

```bash
# Checks: clean tree, HEAD == fresh origin/main, no tag collisions (local OR
# remote), version sanity vs npm, prerelease-line ancestry, release-blocker
# PRs, PREV_TAG dry-run, marker guard.
bun script/release-preflight.ts --version 0.5.0 --stage pre
```

Do NOT proceed if any check fails. If it reports a tag collision, resolve it
explicitly — never delete-and-recreate a tag blind.

### 2. Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md`:

```markdown
## [0.5.0] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

### 3. Run pre-release sanity check

**MANDATORY** — this catches broken binaries before they reach users:

```bash
(cd packages/opencode && OPENCODE_VERSION=0.5.0 bun run pre-release)
```

`pre-release` verifies:
- All required NAPI externals are in `package.json` dependencies
- They're installed in `node_modules`
- A local build produces a binary that actually starts

Do NOT proceed if any check fails.

### 4. Commit, re-preflight, tag, push

Stage files **individually** — never `git add -A` (release worktrees carry
scratch files that must not ship in the release commit). Releasing does not
require being literally on the `main` branch: the invariant is that a clean
HEAD equals freshly fetched `origin/main` (worktrees push via `HEAD:main`).

```bash
git add CHANGELOG.md <other release files>
git commit -m "release: v0.5.0"

# Re-run preflight now that the release commit exists. Stage `tag` allows
# local commits ahead of origin/main (the tree must be clean again).
bun script/release-preflight.ts --version 0.5.0 --stage tag || exit 1

git tag v0.5.0
# Verify the tag points at HEAD BEFORE pushing — a pre-existing tag makes
# `git tag` silently fail, and pushing a stale tag publishes old code.
test "$(git rev-parse v0.5.0)" = "$(git rev-parse HEAD)" || exit 1
# Atomic: branch and tag land together or not at all.
git push --atomic origin HEAD:main v0.5.0
```

### 5. What happens automatically

The `v*` tag triggers `.github/workflows/release.yml` which:

1. **Runs release-critical tests** — typecheck + branding/install tests (gates npm publish)
2. **Builds** all platform binaries (linux/darwin/windows, x64/arm64)
3. **Validates the tag** — format, tag-SHA == checked-out SHA, CHANGELOG entry present (before any publish)
4. **Publishes to npm** — platform-specific binary packages + wrapper package
5. **Creates GitHub Release** — with auto-generated release notes and binary attachments
6. **Publishes Docker image (best-effort)** — to `ghcr.io/altimateai/altimate-code`; failures are logged but do NOT fail the release, so verify manually if you need the image
7. ~~Updates AUR~~ — currently **disabled** (the workflow step is commented out; see `publish.ts` for setup steps to re-enable)

### 6. Verify

After the workflow completes:

```bash
# npm
npm info @altimateai/altimate-code version

# Docker
docker pull ghcr.io/altimateai/altimate-code:0.5.0
```

## What's NOT released anymore

- **Python engine** — eliminated. No PyPI publish, no pip install, no venv.
- **Engine-only releases** — the `engine-v*` tag and `publish-engine.yml` workflow are removed.
- **Engine version bumping** — `bump-version.ts --engine` is no longer needed.

## Prerequisites

Before your first release, set up:

### npm
- Create an npm access token with publish permissions
- Add it as `NPM_TOKEN` in GitHub repository secrets

### GitHub
- `GITHUB_TOKEN` is automatically provided by GitHub Actions
- Enable GitHub Packages for Docker image publishing

### AUR (optional)
- Register the `altimate-code-bin` package on AUR
- Set up SSH key for AUR push access in CI
