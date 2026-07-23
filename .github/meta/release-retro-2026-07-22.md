# /release Skill — Robustness Improvements (retro of v0.8.10, v0.9.1, v0.9.2)

Evidence: full session transcripts of the last three `/release` runs (v0.8.10 2026-06-23, v0.9.1 2026-07-08/09, v0.9.2 2026-07-21), git history between tags, and a Codex code-level review of the plan against `release.yml` / `publish.ts` / `pre-release-check.ts`.

## What's working (keep)

- **Multi-persona review earns its cost.** It caught the `release.yml` `PREV_TAG` bug that would have generated v0.9.1 release notes omitting the entire 165-commit upstream merge (CTO persona), and discovered the CI marker guard had been silently no-op'ing on PRs (bare `catch { return [] }` on a bad base ref).
- **Adversarial tests catch real bugs pre-tag.** v0.9.1: MCP annotation-hint classifier gap. v0.9.2: `transformSnowflakeBody` crash on non-object JSON roots.
- **Targeted `git add`** (v0.9.2) correctly avoided sweeping session scratch files into the release commit — RELEASING.md still says `git add -A` and should be fixed.

---

## P0 — prevent shipping the wrong artifact

### 1. Tag creation is unsafe; both stable releases hit tag collisions — fail closed
- v0.9.1: a stale local `v0.9.1` tag made `git tag` no-op; `git push origin v0.9.1` pushed a tag pointing at a 2641-commit-divergent commit. Only luck (the stale tree predated the current `release.yml`) prevented a wrong publish.
- v0.9.2: stale local `v0.9.2` inherited from upstream OpenCode fork tag history → reactive blind `git tag -d` + recreate.
- **Fix (Step 10):**
  - Preflight `git rev-parse -q --verify refs/tags/v{V}` AND `git ls-remote origin refs/tags/v{V}`. On any collision: **stop and require explicit human resolution** (log what the old tag pointed to). Never auto-delete.
  - After `git tag`: assert `git rev-parse v{V} == git rev-parse HEAD` **before** pushing — post-push verification is too late, the push itself triggers CI/publish.
  - One-time repo policy (separate PR, not release behavior): prune fork-inherited upstream tags and set the upstream remote to `--no-tags`.

### 2. Atomic push; commit/tag/push as separately verified steps
v0.9.2's single `commit && tag && push` chain committed, failed at tag, silently never pushed. Also, pushing `HEAD:main` and the tag as two pushes can leave the tag published against stale main if the branch push is rejected.
- **Fix:** verify commit; verify tag SHA; then `git push --atomic origin HEAD:main v{V}` so branch+tag land together or not at all.

### 3. Gates must carry real exit status and test the real artifact
- v0.9.1: pre-release check backgrounded as `cmd > log 2>&1; echo "exit: $?"` — trailing echo turned a FAILED build into "exit 0". Caught only by reading the log.
- v0.9.2: Step 7 smoke test ran `$PATH`-resolved `altimate --version` → stale global `0.7.3`, not the candidate; never noticed in-session.
- **Fix:** preserve the actual exit code (`tee` + `PIPESTATUS`/`wait`), never append a status echo as the last statement; smoke-test the freshly built artifact by explicit path AND the npm-pack-installed wrapper, asserting the normalized version (`0.9.3`, no `v` — build strips it). Note: `pre-release-check.ts` injects workspace `NODE_PATH` (pre-release-check.ts:110), so it can pass for the wrong reason — a hermetic variant should exist.

### 4. CI publish gate is broken at the source (found by Codex review, verified)
`publish-npm` needs only `[build, sanity-verdaccio]` — **not `test`** (release.yml:182-184). npm can publish while the test job is red. Additional CI gaps:
- Tag-format validation lives in `github-release`, which runs **after** `publish-npm` (release.yml:301) — validate tag syntax/SHA/changelog-entry/version **before** any publish job.
- Partial-publish recovery undefined: platform packages publish concurrently, wrapper after (publish.ts:125); a mid-run failure leaves immutable partial npm state and re-runs may fail on already-published versions. Make publish idempotent/resumable and document per-phase recovery.
- Docker/AUR/Homebrew publish errors are swallowed (publish.ts:192) while RELEASING.md promises they "happen automatically" — make them gated jobs or correct the doc.
- CI smoke tests don't assert the exact released version.

**These are workflow/script PRs, not skill prose.**

---

## P1 — codify reality: preflight as a deterministic script

### 5. Replace Step 2's "must be on main" with the invariant that actually matters
All three releases deviated (main checked out in another worktree; released from a feature branch whose HEAD equaled origin/main). The correct branch-independent invariant: **after a fresh `git fetch`, clean HEAD == `origin/main`**; push via `HEAD:main`. If it doesn't hold, stop.

### 6. Move the deterministic checks into `script/release/preflight.ts`
Six `fix: [release]` commits in one cycle (Bun pin, Verdaccio .dockerignore, version derivation, npm E413 de-dupe, smoke-test target, marker-guard base ref) = every release debugs the pipeline live. The skill's new Step 2 = run the script. Checks (objective invariants only):
- clean worktree; HEAD == fresh origin/main (per #5) — also covers the "user just merged a PR" staleness that forced a manual interruption in v0.9.2
- tag collision, local + remote (per #1) — fail closed
- target version: valid SemVer, strictly greater than current npm `latest`, not already published (NOT equality with package.json — it intentionally says `1.17.9`)
- prerelease ancestry scoped to the target release line: e.g. releasing `v0.9.1` with `v0.9.0-beta.*` not an ancestor of origin/main → stop (v0.9.1's Step-2 stop turned into a 17-hour merge side-quest improvised via 3 AskUserQuestion rounds)
- open PRs labeled `release-blocker` → stop
- `PREV_TAG` dry-run: evaluate release.yml's previous-tag logic locally, print which tag release notes will diff against
- marker guard full run, complete violation list in one pass (v0.9.2 took 7 serial fix rounds for 11 hunks because output was consumed one hunk at a time)

### 7. Prerequisites fail → stop; don't improvise
The release skill should not grow an upstream-merge/admin-bypass decision tree. If preflight fails on divergence, stop `/release`, do the prerequisite work as its own task, re-invoke. If the user directs an admin `--admin` merge to satisfy a prerequisite (as in v0.9.1), the Step 12 summary must disclose that branch protection was bypassed.

---

## P1 — close the loop on review output

### 8. Every deferred finding gets a durable disposition before the ship gate
v0.8.10 deferred 3 findings; zero filed — they exist only in a chat transcript. v0.9.1/v0.9.2 filed 6 and 4 (good). Gate: each deferred item has an issue link (new or existing) or an explicit user opt-out; the summary table gets a "Deferred → filed" row so an empty list is visible. Same rule for CI jobs waved through as "flaky" (v0.9.2's Verdaccio no-internet re-run was never tracked): link a durable issue, not necessarily a new one per flake.

### 9. Unverified P0-candidates: validate or block — no approval-string bypass
v0.9.1's Chaos Gremlin flagged possible silent global-config loss; direct verification failed twice on tooling friction and the release shipped on indirect reasoning. Rule: a P0-candidate must be either empirically validated, or explicitly downgraded with written rationale reviewed by the user. It cannot ship as a P0 with a warning label.

### 10. Step-skipping must be visible
Step 7 (UX smoke) was silently absorbed in v0.9.1 and mis-executed in v0.9.2; optional Verdaccio was skipped without mention. Every step gets a row in the Step 12c summary table (✅/⏭️/❌) so silent omission is structurally impossible.

---

## P2 — agent ergonomics (real friction, but not release safeguards)

- **Status on state changes:** both v0.8.10 (11.5-min silent CI wait) and v0.9.1 (104-min Codex review) ended with the user typing "done?". Post an update on every CI state change; long background reviews ping every ~20-30 min.
- **Persona delivery protocol:** 3 of 5 v0.9.2 reviewers went idle without delivering and needed manual nudges. Persona prompt must end: "Send your full review via SendMessage to main as your final action."
- **Shell hygiene:** explicit working directories instead of `cd X &&` chains (2 failures in v0.8.10); Read CHANGELOG.md before Edit (v0.8.10); background suite runs tee full output to a file (v0.9.2 re-ran an 11,551-test suite just to learn which test failed).
- **Step 12 scope:** include commenting the fix/version on the originating bug-report issue (v0.9.2 user had to ask separately).
- **Docs:** update RELEASING.md — targeted staging instead of `git add -A`; document the worktree/`HEAD:main` path; stop promising Docker/AUR/Homebrew until they're gated jobs.
- **Fan-out budget:** v0.9.1 hit the weekly usage limit mid-release (7+ concurrent heavy agents); run persona reviews on cheaper models and stagger heavy fan-out in long sessions.

---

## Top 5 by robustness per unit of process (Codex-concurred)

1. Fail-closed tag checks + SHA assertions (#1)
2. Atomic `HEAD:main`+tag push with per-step verification (#2)
3. Real exit-status handling + exact-artifact/version smoke test (#3)
4. Deterministic preflight script, objective invariants only (#6)
5. Branch-independent "HEAD == fresh origin/main" base check (#5)

Plus one CI PR that outranks all skill prose: make `publish-npm` depend on `test` and move tag validation before publish (#4).
