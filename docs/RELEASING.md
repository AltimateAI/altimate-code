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

### 1. Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md`:

```markdown
## [0.5.0] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

### 2. Commit and tag

```bash
git add -A
git commit -m "release: v0.5.0"
git tag v0.5.0
git push origin main v0.5.0
```

### 3. What happens automatically

The `v*` tag triggers `.github/workflows/release.yml` which:

1. **Builds** all platform binaries (linux/darwin/windows, x64/arm64)
2. **Publishes to npm** — platform-specific binary packages + wrapper package
3. **Creates GitHub Release** — with auto-generated release notes and binary attachments
4. **Updates AUR** — pushes PKGBUILD update to `altimate-code-bin`
5. **Publishes Docker image** — to `ghcr.io/altimateai/altimate-code`

### 4. Verify

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
