# Release confidence audit — PR #964 (v1.17.9 merge)

Date: 2026-06-26. Answers "how do we get confidence" via three lenses the user chose:
**differential vs last release**, **coverage/gate audit**, **scope the shipped surface**.

## TL;DR
- Every issue found this session is **fixed and gated** (a test that fails without the fix;
  mutation-checked where noted).
- The **differential audit (main vs merge)** gave a *bounded, complete* accounting of
  merge-dropped fork features: exactly **2 shipped security regressions** (both restored),
  plus 1 dropped test file (restored). The rest of the fork security surface survives.
- **Severity is converging**: Kilo CRITICAL → codex pass 3 found no exploitable escape →
  the remaining differential finds are bounded.
- **Key lesson**: adversarial review (Kilo + 3 codex passes) and CI **cannot catch dropped
  code**. Only a differential against the last good release can. That is the gate to keep.

## Scope — shipped vs not (verified, not assumed)
- **Shipped binary** = `packages/opencode` (built single-file). Its tool registry
  (`tool/registry.ts:353-354`) uses `packages/opencode/src/tool/grep.ts`/`glob.ts`
  (→ `assertExternalDirectory` → symlink-aware `containsPath`).
- **NOT shipped** = `packages/core` v2 tools (incl. the v2 `grep`/`glob` where Kilo+codex found
  containment bugs — `@opencode-ai/core/tool/grep` is imported nowhere in the shipped binary),
  the v2 `httpapi` tree (the shipped server is the Hono `server/server.ts`), `packages/cli`,
  `packages/server`. Confidence effort should weight the shipped surface.

## Coverage map — every finding → fix → gate
| # | Finding | Shipped? | Fix | Gate (test) |
|---|---|---|---|---|
| 1 | TUI log flood (stderr) | yes | log shim quiet-by-default (lazy env) + worker console guard | `cli/smokes/output-hygiene` + `fork-feature-guards` |
| 2 | `console.*` bypasses worker guard (Bun) | yes | guard overrides `console.*` too | `fork-feature-guards` + output-hygiene |
| 3 | Logo garbled (lowercase 4-row) | yes | revert to clean uppercase wordmark | `fork-feature-guards` (ALT glyphs) |
| 4 | Trace prune deletes NEWEST (descending ids) | yes | prune by mtime | `tracing-finalize-sync` (mutation-checked) |
| 5 | Upgrade 404 on branch builds | yes | `isPublishableChannel` allowlist on all 3 upgrade sites | `installation/upgrade.test` |
| 6 | fff picker leaks other repos | yes (core, TUI-reachable) | scope fff to project | `fork-feature-guards` |
| 7 | snowflake-sdk console logs corrupt TUI | yes (driver) | silence configure() + re-suppress after connect | `drivers/snowflake-logging.test` |
| 8 | grep/glob containment (symlink/cwd) | **no (v2-core)** | realPath-contain actual cwd + file | `core/tool-grep-glob-containment` (real symlink, mutation-checked) |
| 9 | **Symlink boundary regression (#209 drop)** | **yes** | restore `containsReal` in `instance-context.containsPath` | `project/instance-context-containment` (mutation-checked) |
| 10 | **Sensitive-write guard regression (#209 drop)** | **yes** | restore `assertSensitiveWrite` + wire into write/edit/apply_patch | `file/security-e2e` (un-neutered) + `fork-feature-guards` presence |
| 11 | `path-traversal.test.ts` dropped (15 cases) | — | restored from main | the file itself (15 pass) |
| 12 | CI subprocess flakiness (15 timeouts) | test-infra | prebuilt test CLI (OPENCODE_TEST_CLI) | green CI |

## The 2 shipped security regressions (differential's headline)
Both from #209 ("harden path sandboxing", CVE-class GHSA-w5fx-fh39-j5rw / CVE-2025-54794),
silently reverted by the overlay:
1. **Symlink boundary** — the merge wired `external-directory.ts` to a NEW lexical
   `containsPath` copy, dropping symlink resolution. Fixed: use `Filesystem.containsReal`.
2. **Sensitive-write guard** — `assertSensitiveWrite` + its 4 call sites dropped; a private
   copy inlined into the test hid it (green CI). Fixed: restored function + wiring + un-neutered test.

## Why they slipped past every existing guard (detection gaps — fixed/known)
- The #209 security-e2e test exercised a *sibling* (`Instance.containsPath`) / an *inlined copy*,
  not the production path that was rewired/dropped → green while the behavior was gone.
- `script/upstream/analyze.ts --markers` only flags *new unmarked code in upstream files* — it has
  **no notion of a fork behavior that should be present but is missing**. By design it can't catch drops.
- `fork-feature-guards.test.ts` had no entry for these behaviors. **Now added** (presence guards for
  the sensitive-write wiring + the symlink-aware boundary's effects).

## Recommended permanent gate (the confidence multiplier)
A merge can silently DROP a fork feature; review/CI can't see absent code. Make drop-detection
first-class:
1. Keep extending `fork-feature-guards.test.ts` — assert each fork BEHAVIOR's call sites exist
   (not just a marker, not just a definition). Two were added this session.
2. Consider a `--require-behaviors` mode in `analyze.ts` that, for a list of (file, must-contain)
   pairs derived from main's `altimate_change` blocks, fails if a behavior/call-site is missing in HEAD.
3. The **runtime differential** (run the last release + the merge build on the same CLI inputs +
   a benchmark, diff) remains the strongest end-to-end "no regression" signal — recommended before
   wide release (option not yet executed this session).
