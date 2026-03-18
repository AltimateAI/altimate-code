# Releasing altimate-code

This guide covers the complete release process for the altimate-code monorepo.

## Overview

The monorepo produces two publishable packages:

| Package | Registry | Trigger |
|---------|----------|---------|
| `@altimateai/altimate-code` | npm | `v*` tag (e.g., `v0.3.0`) |
| `altimate-code` | npm | Same `v*` tag (unscoped alias) |
| `altimate-engine` | PyPI | Same `v*` tag (published alongside CLI) |

Both packages are versioned and released together. The CLI embeds the expected engine version at build time and auto-installs it on end-user machines.

## Version Management

### Engine version (Python)

The engine version lives in two files that must stay in sync:

- `packages/altimate-engine/pyproject.toml` → `version = "X.Y.Z"`
- `packages/altimate-engine/src/altimate_engine/__init__.py` → `__version__ = "X.Y.Z"`

Use the bump script to update both at once:

```bash
bun run packages/altimate-code/script/bump-version.ts --engine 0.2.0

# Preview changes without writing:
bun run packages/altimate-code/script/bump-version.ts --engine 0.2.0 --dry-run
```

### CLI version (TypeScript)

The CLI version is determined automatically at build time:

- **Explicit**: Set `OPENCODE_VERSION=0.2.0` environment variable
- **Auto-bump**: Set `OPENCODE_BUMP=patch` (or `minor` / `major`) — fetches current version from npm and increments
- **Preview**: On non-main branches, generates `0.0.0-{branch}-{timestamp}`

The version is injected into the binary via esbuild defines at compile time.

## Release Process

### 1. Bump the engine version (if changed)

```bash
bun run packages/altimate-code/script/bump-version.ts --engine 0.2.0
```

### 2. Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md`:

```markdown
## [0.2.0] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

### 3. Commit and tag

```bash
git add -A
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

### 4. What happens automatically

The `v*` tag triggers `.github/workflows/release.yml` which:

1. **Builds** all platform binaries (linux/darwin/windows, x64/arm64)
2. **Publishes to npm** — platform-specific binary packages + scoped wrapper `@altimateai/altimate-code` + unscoped wrapper `altimate-code`
3. **Publishes to PyPI** — `altimate-engine` via OIDC trusted publishing
4. **Creates GitHub Release** — with auto-generated release notes and binary attachments
5. **Updates Homebrew tap** — pushes formula update to `AltimateAI/homebrew-tap`
6. **Updates AUR** — pushes PKGBUILD update to `altimate-code-bin`
7. **Publishes Docker image** — to `ghcr.io/altimateai/altimate-code`

### 5. Verify

After the workflow completes:

```bash
# npm (both scoped and unscoped should show same version)
npm info @altimateai/altimate-code version
npm info altimate-code version

# PyPI
pip install altimate-engine==0.2.0

# Homebrew
brew update && brew info altimate/tap/altimate-code

# Docker
docker pull ghcr.io/altimateai/altimate-code:0.2.0
```

## Engine-Only Releases

If you need to release just the Python engine without a CLI release (e.g., a bugfix):

```bash
bun run packages/altimate-code/script/bump-version.ts --engine 0.2.1
git add -A
git commit -m "release: engine-v0.2.1"
git tag engine-v0.2.1
git push origin main engine-v0.2.1
```

This triggers `.github/workflows/publish-engine.yml` which publishes only to PyPI.

**Important**: The next CLI release will automatically pick up the new engine version since build.ts reads it from `pyproject.toml`.

## Prerequisites

Before your first release, set up:

### npm
- Create an npm access token with publish permissions
- Add it as `NPM_TOKEN` in GitHub repository secrets

### PyPI (Trusted Publishing)
1. Go to https://pypi.org/manage/account/publishing/
2. Add a new pending publisher:
   - Package: `altimate-engine`
   - Owner: `AltimateAI`
   - Repository: `altimate-code`
   - Workflow: `release.yml`
   - Environment: `pypi`
3. Create a `pypi` environment in GitHub repo settings (Settings > Environments)

### GitHub
- `GITHUB_TOKEN` is automatically provided by GitHub Actions
- Enable GitHub Packages for Docker image publishing

### Homebrew
- Create `AltimateAI/homebrew-tap` repository
- The `GITHUB_TOKEN` needs write access to this repo

### AUR (optional)
- Register the `altimate-code-bin` package on AUR
- Set up SSH key for AUR push access in CI
