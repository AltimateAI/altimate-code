# Upstream Merge Runbook

We maintain a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode). This directory contains automation to merge upstream releases into our fork while preserving our customizations and rebranding user-facing surfaces.

## Fork Strategy

- **Internal names are kept as-is** — `@opencode-ai/`, `OPENCODE_*` env vars, `packages/opencode/`, `.opencode/` config dir. This minimizes merge conflicts and keeps upstream compatibility.
- **User-facing surfaces are rebranded** — domains (`altimate.ai`), GitHub org (`AltimateAI`), product name (`Altimate Code`), install commands, app IDs.
- **Custom code is protected** — files in `keepOurs` patterns are never overwritten by upstream. Our Python engine, bridge layer, altimate tools, and CI workflows stay untouched.
- **Upstream-only packages are skipped** — platform packages (app, web, desktop, etc.), nix, SST infra, and translated READMEs are discarded during merge.

### Major versions

`upstreamBaseline` in `utils/config.ts` records the upstream tag the fork is based on (currently `v1.17.9`). Bump it after each upstream merge lands. `list-versions.ts` lists and suggests only releases with that major version, and reports when newer-major tags exist. Both `merge.ts` and `bridge-merge.ts` reject cross-major targets, including in dry-run mode, before changing Git state. Upstream v2 replaces `packages/opencode` and the plugin, tool, session and server APIs, so moving to it is a re-port (Altimate features as v2 plugins on a thin branded build), not a merge with these scripts.

## Prerequisites

```bash
# 1. Make sure the upstream remote exists
git remote -v | grep upstream
# If missing:
git remote add upstream https://github.com/anomalyco/opencode.git

# 2. Install merge tooling dependencies
cd script/upstream && bun install && cd ../..

# 3. Ensure your working tree is clean
git status  # should show no uncommitted changes
```

## Step-by-Step Merge Process

### 1. Check available upstream versions

```bash
bun run script/upstream/list-versions.ts
```

This shows upstream tags, their merge status (merged/available), and how many commits behind we are. It suggests the next version to merge.

### 2. Preview what will change (dry-run)

```bash
bun run script/upstream/merge.ts --version v1.2.21 --dry-run
```

This categorizes every file that would change:
- **Keep ours** (green) — auto-resolved by keeping our version
- **Skip files** (cyan) — upstream-only, auto-accepted then deleted
- **Lock files** (yellow) — regenerated via `bun install`
- **Transformable** (magenta) — branding transforms applied
- **Pass-through** (dim) — accepted from upstream without changes

Review this to understand the scope before proceeding.

### 3. Run the merge

```bash
bun run script/upstream/merge.ts --version v1.2.21
```

The script will:
1. Create a backup branch (`backup/main-<timestamp>`)
2. Create a merge branch (`upstream/merge-v1.2.21`)
3. Run `git merge v1.2.21`
4. Auto-resolve conflicts using keepOurs/skipFiles/lock-files strategies
5. Apply branding transforms to user-facing text
6. Restore our package names and versions

**If there are no remaining conflicts**, the script commits, pushes, and prints a PR creation command.

**If conflicts remain**, the script exits with a list of files to fix manually. See next step.

### 4. Resolve remaining conflicts (if any)

```bash
# See what's still conflicted
git diff --name-only --diff-filter=U

# Open each file, resolve the <<<< ==== >>>> markers
# Pay attention to `altimate_change` markers — they delimit our custom code

# Stage resolved files
git add <resolved-file>

# Resume the merge (picks up from branding transforms onward)
bun run script/upstream/merge.ts --continue
```

### 5. Verify branding

```bash
bun run script/upstream/analyze.ts --branding
```

This scans the codebase for upstream branding that may have leaked through (e.g., `opencode.ai` URLs, `anomalyco` GitHub refs). Exit code 1 means leaks were found.

```bash
# For full details on each leak
bun run script/upstream/analyze.ts --branding --verbose
```

Some matches are false positives (internal names we intentionally keep). If you find real leaks, either:
- Add a branding rule in `utils/config.ts`
- Or fix the specific file manually

### 6. Verify typecheck and tests

```bash
bun install
bunx turbo typecheck
bun run --cwd packages/opencode test
```

### 7. Create the PR

The merge script prints a `gh pr create` command at the end. Review the diff, then merge.

## CLI Reference

| Command | Purpose |
|---------|---------|
| `bun run script/upstream/list-versions.ts` | List upstream tags with merge status |
| `bun run script/upstream/merge.ts --version <tag>` | Run full merge |
| `bun run script/upstream/merge.ts --dry-run --version <tag>` | Preview changes only |
| `bun run script/upstream/merge.ts --continue` | Resume after conflict resolution |
| `bun run script/upstream/merge.ts --no-push --version <tag>` | Merge without pushing |
| `bun run script/upstream/analyze.ts --branding` | Audit for branding leaks |
| `bun run script/upstream/analyze.ts --branding --json` | Branding audit (CI-friendly) |
| `bun run script/upstream/analyze.ts` | Check `altimate_change` marker integrity |
| `bun run script/upstream/analyze.ts --markers --base main` | Check PR for missing markers |
| `bun run script/upstream/analyze.ts --markers --base main --strict` | Same, but fail CI on warnings |
| `bun run script/upstream/analyze.ts --print-baseline` | Print the pinned upstream baseline tag |
| `bun run script/upstream/verify-restructure.ts` | Verify branch restructure |

## Configuration

All config lives in `utils/config.ts` (TypeScript for type safety). Key sections:

### `keepOurs` — Files we own entirely

These are auto-resolved by keeping our version during conflicts:

| Pattern | What it protects |
|---------|-----------------|
| `README.md`, `CONTRIBUTING.md`, etc. | Our documentation |
| `.github/workflows/**`, `.github/actions/**` | Our CI/CD |
| `packages/altimate-engine/**` | Python engine (100% our code) |
| `packages/opencode/src/altimate/**` | Custom TypeScript tools |
| `packages/opencode/src/bridge/**` | Python-TS JSON-RPC bridge |
| `script/upstream/**` | This merge tooling |
| `experiments/**`, `docs/**`, `.claude/**` | Research and AI config |
| `install` | Our install script |
| `sdks/**` | Our SDKs |

### `skipFiles` — Upstream packages we don't use

These are accepted from upstream then effectively discarded (deleted from our repo):

| Pattern | Why we skip it |
|---------|---------------|
| `packages/app/**`, `packages/web/**` | Hosted platform UI |
| `packages/desktop/**`, `packages/desktop-electron/**` | Desktop app |
| `packages/console/**`, `packages/enterprise/**` | SaaS features |
| `packages/docs/**`, `packages/ui/**` | Upstream docs/components |
| `packages/extensions/**`, `packages/slack/**` | Integrations |
| `packages/function/**`, `packages/identity/**` | Serverless/auth |
| `packages/containers/**`, `packages/storybook/**` | Container/Storybook |
| `infra/**`, `sst.config.ts`, `sst-env.d.ts` | SST cloud infrastructure |
| `nix/**`, `flake.nix`, `flake.lock` | Nix packaging |
| `specs/**` | Upstream project specs |
| `README.*.md` | Translated READMEs |

### `preservePatterns` — Lines excluded from branding transforms

Lines containing these strings are left untouched to avoid breaking internal code:

- `@opencode-ai/` — npm package scope
- `packages/opencode` — internal directory path
- `OPENCODE_` — environment variables
- `.opencode/` — config directory
- `opencode.json` — config filenames
- `import { ` — import statements

### Branding Rules

Ordered most-specific-first to prevent partial matches. Categories:

| Category | Example |
|----------|---------|
| URL subdomains | `docs.opencode.ai` -> `docs.altimate.ai` |
| Root domain | `opencode.ai` -> `altimate.ai` |
| GitHub org/repos | `anomalyco/opencode` -> `AltimateAI/altimate-code` |
| Container registry | `ghcr.io/anomalyco` -> `ghcr.io/AltimateAI` |
| Emails | `bot@opencode.ai` -> `bot@altimate.ai` |
| App IDs | `ai.opencode.desktop` -> `ai.altimate.code.desktop` |
| Social | `x.com/altaborodin` -> `x.com/Altimateinc` |
| Product name | `OpenCode` -> `Altimate Code` |
| Install commands | `npm i -g opencode-ai` -> `npm i -g altimate-code` |
| Homebrew | `anomalyco/tap/opencode` -> `AltimateAI/tap/altimate-code` |

### Adding a new branding rule

1. Open `utils/config.ts`
2. Add your rule to the appropriate category array
3. Place more specific patterns BEFORE less specific ones
4. Test: `bun run script/upstream/analyze.ts --branding`

```typescript
// Example: adding a new subdomain
{
  pattern: /newservice\.opencode\.ai/g,
  replacement: "newservice.altimate.ai",
  description: "New service subdomain",
},
```

## Change Markers

When we modify upstream files (not fully custom ones), we wrap our changes with markers:

```typescript
// altimate_change start — description of what we changed
... our modifications ...
// altimate_change end
```

These help during conflict resolution — you can see exactly what we changed vs upstream code. The `analyze.ts` script audits for unclosed marker blocks.

### Upstream Bug Fixes (`upstream_fix:` tag)

When fixing a **bug in upstream code** (not adding a feature), use the `upstream_fix:` tag in the marker description:

```typescript
// altimate_change start — upstream_fix: days/hours calculation were swapped
const days = Math.floor(input / 86400000)
const hours = Math.floor((input % 86400000) / 3600000)
// altimate_change end
```

**Why this matters:** Regular `altimate_change` markers protect features we added — they're permanent. But upstream bug fixes are **temporary**: once upstream ships their own fix, we should drop our marker and accept theirs.

Without the `upstream_fix:` tag:
- If upstream fixes the same bug, the merge creates a conflict (good — forces review)
- But the reviewer doesn't know our change was a bug fix vs a feature, so they may keep both

With the `upstream_fix:` tag:
- Before each merge, run `--audit-fixes` to see all bug fixes we're carrying
- During conflict resolution, reviewers know to check "did upstream fix this?" and can safely drop our version
- After merge, any remaining `upstream_fix:` markers represent bugs upstream hasn't fixed yet

**When to use which:**

| Scenario | Marker |
|----------|--------|
| New feature/custom code | `// altimate_change start — description` |
| Fix bug in upstream code | `// altimate_change start — upstream_fix: description` |
| Branding change | No marker (handled by branding transforms) |
| Code in `keepOurs` files | No marker needed |

**Audit before merging:**

```bash
# List all upstream bug fixes we're carrying
bun run script/upstream/analyze.ts --audit-fixes
```

## File Organization

```
script/upstream/
├── README.md                 # This runbook
├── merge.ts                  # Main merge orchestrator
├── analyze.ts                # Branding audit, marker analysis, and CI marker guard
├── list-versions.ts          # List upstream tags with status
├── verify-restructure.ts     # Branch comparison verification
├── package.json              # Dependencies (minimatch)
├── tsconfig.json             # TypeScript config
└── utils/
    ├── config.ts             # All branding rules and merge config
    ├── git.ts                # Git command wrappers (sync + async)
    ├── logger.ts             # Colored terminal logging and ANSI formatting
    └── report.ts             # Merge report types and output
```

## CI Integration

The **Marker Guard** CI job (in `.github/workflows/ci.yml`) runs automatically on every PR. It checks whether any upstream-shared files (such as `packages/opencode/src/`) have new code without `altimate_change` markers. Ownership is determined from the pinned `upstreamBaseline` tag in `utils/config.ts`, so moving upstream branches to a new major version does not disable checks on v1 files. This prevents accidental overwrites during future upstream merges.

After installing the merge tooling dependencies, CI fetches the upstream remote and then explicitly fetches the baseline tag into the dedicated `refs/upstream-baseline/` namespace. The analyzer reads this full ref to avoid collisions with same-named fork tags or local branches:

```bash
baseline=$(bun run script/upstream/analyze.ts --print-baseline)
git fetch upstream "refs/tags/${baseline}:refs/upstream-baseline/${baseline}" --no-tags
```

If the namespaced baseline ref is missing locally, the analyzer attempts this fetch once and retries the check. If the ref is still unavailable, it warns on stderr with the tag and fetch command, then falls back to directory-based ownership checks. Fetch the tag into this namespace to restore the baseline-based check.

```bash
# What CI runs:
bun run script/upstream/analyze.ts --markers --base origin/main --strict
```

If the job fails, wrap your custom code with markers:

```typescript
// altimate_change start — description of your change
... your modifications ...
// altimate_change end
```

## Troubleshooting

### "Working tree has uncommitted changes"

Commit or stash your work before merging:
```bash
git stash
bun run script/upstream/merge.ts --version v1.2.21
git stash pop
```

### Conflicts remain after auto-resolution

This is normal for complex merges. The script lists exactly which files need manual resolution. Look for `altimate_change` markers to understand what's ours vs upstream.

### Branding leaks after merge

Run `bun run script/upstream/analyze.ts --branding --verbose` to see details. Common fixes:
- Add a new rule in `utils/config.ts` if it's a pattern we should always replace
- Add to `preservePatterns` if it's a false positive
- Fix manually if it's a one-off

### Upstream remote not found

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream --no-tags
```

### Aborting a merge

```bash
git merge --abort
git checkout main
git branch -D upstream/merge-v1.2.21
```

### Recovering from a failed merge

The script creates a backup branch before starting:
```bash
git branch | grep backup/
git checkout main
git reset --hard backup/main-<timestamp>
```

### State file left behind

If interrupted, delete the state file:
```bash
rm .upstream-merge-state.json
```

## Inspiration

This tooling was inspired by [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)'s upstream merge automation, adapted for Altimate Code's fork structure and branding requirements.
