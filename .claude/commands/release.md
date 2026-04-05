---
description: Release a new version of altimate-code. Reviews code, fixes issues, generates changelog, runs checks, tags, pushes, and monitors CI. Everything ships clean in one release.
---

# Release altimate-code

Automate the complete release process. The core principle: **find and fix everything before tagging. No follow-up PRs.**

## Input

`$ARGUMENTS` = version bump type: `patch` (default), `minor`, or `major`. Can also be an explicit version like `0.6.0`.

---

## Step 0: Read the Release Guide

Read the official release documentation and current changelog style:

```bash
cat docs/RELEASING.md
head -80 CHANGELOG.md
```

Cross-check RELEASING.md against this skill. If it has new steps or prerequisites, warn the user and adapt.

## Step 1: Determine Version

```bash
npm info @altimateai/altimate-code version
```

- `patch` or empty: bump patch (e.g., `0.5.17` → `0.5.18`)
- `minor`: bump minor (e.g., `0.5.17` → `0.6.0`)
- `major`: bump major (e.g., `0.5.17` → `1.0.0`)
- Explicit version (matches `\d+\.\d+\.\d+`): use directly

Confirm with user: "Releasing **v{NEXT_VERSION}** (current: v{CURRENT_VERSION}). Proceed?"

## Step 2: Ensure on Main and Clean

```bash
git branch --show-current
git status --short
git fetch origin main
git log HEAD..origin/main --oneline
```

- Must be on `main`. If not, stop.
- Working tree must be clean. If dirty, stop.
- Must be up to date with remote. If behind, stop.

## Step 3: Identify What Changed

```bash
git log v{CURRENT_VERSION}..HEAD --oneline --no-merges
git log v{CURRENT_VERSION}..HEAD --oneline --no-merges --grep="^feat" --grep="^fix"
git diff v{CURRENT_VERSION}..HEAD --stat
git diff v{CURRENT_VERSION}..HEAD --name-only -- 'packages/opencode/src/**' 'packages/dbt-tools/src/**'
```

For each `feat:` and `fix:` commit, read its full diff (`git show {HASH} --stat`).

Build a list of **user-facing changes** — features added, bugs fixed, behavior modified. Ignore `ci:`, `test:`, `chore:` that don't affect UX.

## Step 4: Multi-Persona Code Review

**Purpose:** Find issues BEFORE we write tests or changelog. Everything found here gets fixed before the release ships. No follow-up PRs.

### 4a: Prepare the evaluation brief

Gather:
1. **Change summary** — the user-facing changes list from Step 3
2. **Source files changed** — from `git diff --name-only`
3. **Diff stats** — `git diff v{CURRENT_VERSION}..HEAD --stat`
4. **Version context** — what version this is, time since last release

### 4b: Launch the five-member evaluation team

Spawn **five agents in parallel**. Each agent MUST read the actual source code diffs — not just the summary. Each reviews from their unique perspective:

1. **CTO** — Technical risk, security exposure, breaking changes, operational readiness. "Would I deploy this on a Friday?"

2. **Product Manager** — Feature completeness, user value, messaging clarity, docs accuracy, changelog story. "Can I write a release announcement customers care about?"

3. **End User (Data Engineer)** — Day-to-day usability, error messages, discoverability, workflow friction. "Will this make my Monday easier or harder?"

4. **Tech Lead** — Code quality, test coverage, maintainability, marker guard, CI health. "Will we regret this in two weeks?"

5. **Chaos Gremlin** — Random adversarial perspective (security auditor, support engineer, new hire, compliance officer, etc.). Different each release. Asks the uncomfortable question nobody else thought of.

Each agent produces:

```markdown
## {Persona} Review
### Verdict: SHIP / HOLD / SHIP WITH NOTES
### What looks good
### Concerns
- **[P0/P1/P2]** {concern} — {why}
### Actionable fixes (code changes needed before release)
- {specific file + what to change}
### Release notes feedback
```

**Key difference from a post-release review:** Each agent must classify concerns as either:
- **Actionable** — can be fixed now in <30 min (stale docs, missing timeout, wording issues, missing guards)
- **Deferred** — requires significant design work (>30 min), fine for next release

### 4c: Synthesize and triage

After all five agents complete:

1. **Collect all concerns**, deduplicate
2. **Build the consensus table:**

```markdown
| Persona | Verdict | P0 | P1 | P2 | Key Concern |
|---------|---------|----|----|----|----|
```

3. **Split actionable vs deferred:**

```markdown
### Actionable (fix now, before tagging)
| # | Issue | File(s) | Est. | Flagged by |
|---|-------|---------|------|------------|
| 1 | Missing timeout on validateCredentials | client.ts | 5 min | Tech Lead |
| 2 | Stale docs reference wrong command | gitlab.md | 10 min | End User |

### Deferred (file issues for next release)
| # | Issue | Reason for deferral |
|---|-------|---------------------|
| 1 | Inline per-line GitLab comments | New feature, not a fix |
```

### 4d: Gate

- **Any P0** → Release blocked. Fix first, re-run from Step 3.
- **3+ HOLD verdicts** → Release blocked.
- **Actionable P1s exist** → Proceed to Step 5 (fix them).
- **No actionable items** → Skip Step 5, proceed to Step 6.

## Step 5: Fix Actionable Issues

**Purpose:** Fix every actionable P1/P2 found by the review. This is why the review is early — so fixes ship in THIS release, not the next one.

### 5a: Fix each issue on main

For each actionable item from Step 4c:

1. Read the file(s) involved
2. Make the fix
3. Run the relevant tests
4. Commit with a descriptive message:

```bash
echo "fix: {description}" > .github/meta/commit.txt
git commit -F .github/meta/commit.txt
```

### 5b: File issues for deferred items

For each deferred item, create a GitHub issue:

```bash
gh issue create --repo AltimateAI/altimate-code \
  --title "{type}: {description}" \
  --body "Found during v{NEXT_VERSION} release review. Deferred because: {reason}"
```

### 5c: Re-verify after fixes

Run typecheck and marker guard to confirm fixes are clean:

```bash
bun turbo typecheck
bun run script/upstream/analyze.ts --markers --base main --strict
```

**If fixes introduced new issues,** fix those too. Loop until clean.

## Step 6: Adversarial Testing

**Purpose:** Write and run adversarial tests covering ALL changes — including the fixes from Step 5. This ensures the fixes themselves don't introduce new problems.

### 6a: Write adversarial tests

Read the changed source files. Create test file at `packages/opencode/test/skill/release-v{NEXT_VERSION}-adversarial.test.ts`.

Follow established patterns (see `test/altimate/adversarial.test.ts`, `test/skill/release-v0.5.14-adversarial.test.ts`).

**Categories to cover per change:**
1. Empty/null/undefined inputs
2. Boundary values (zero, max, negative)
3. Type confusion
4. Injection attacks (SQL, command, prototype pollution, path traversal)
5. Error propagation

**Test quality rules:**
- Meaningful assertions, not just "doesn't throw"
- Deterministic — no timing deps, no shared state
- No `mock.module()` — use `Dispatcher.register()`/`reset()` or `spyOn()`

### 6b: Run tests

```bash
cd packages/opencode && bun test --timeout 30000 test/skill/release-v{NEXT_VERSION}-adversarial.test.ts
cd packages/opencode && bun test --timeout 30000
```

### 6c: Gate

- **All pass** → Continue
- **Test finds a real bug** → Fix the bug, run again. If the bug is in code from Step 5, fix it. If in original release code, commit the fix.
- **Test bug** → Fix the test, continue

## Step 7: UX Verification

### 7a: Smoke test

```bash
altimate --version
altimate --help
```

### 7b: Run feature-specific tests

Run all test files for the changed features:

```bash
cd packages/opencode && bun test --timeout 30000 {relevant test files}
```

### 7c: Verify docs match code

For each feature in this release, check that the corresponding doc in `docs/docs/` is accurate. Stale docs should have been caught in Step 4 and fixed in Step 5, but double-check.

### 7d: Gate

If any scenario fails with P0 severity (crash, data loss), stop and fix. P2 cosmetics can be noted for next release.

## Step 8: Generate Changelog

### 8a: Get all commits

```bash
git log v{CURRENT_VERSION}..HEAD --oneline --no-merges
```

**Important:** This now includes both the original changes AND the fixes from Step 5. Include everything.

### 8b: Write the changelog entry

Categorize into **Added**, **Fixed**, **Changed**. Use bold title + em-dash description matching existing style. Incorporate release notes feedback from the Step 4 persona reviews.

### 8c: Review with user

Show the changelog and ask: "Does this look correct? Edit anything?"

Wait for approval.

## Step 9: Pre-Release Checks

Run all mandatory checks:

```bash
# Pre-release sanity (binary builds and starts)
cd packages/opencode && bun run pre-release

# Marker guard
bun run script/upstream/analyze.ts --markers --base main --strict
```

**Gate: ALL CHECKS MUST PASS.** Stop on failure.

### Optional: Verdaccio sanity suite

If Docker is available:

```bash
cd packages/dbt-tools && bun run build && cd ../..
docker compose -f test/sanity/docker-compose.verdaccio.yml up \
  --build --abort-on-container-exit --exit-code-from sanity
```

If Docker unavailable, skip — CI will catch it.

## Step 10: Commit, Tag, Push

```bash
# Stage changelog + any adversarial tests
git add CHANGELOG.md packages/opencode/test/skill/release-v{NEXT_VERSION}-adversarial.test.ts

# Commit
echo "release: v{NEXT_VERSION}" > .github/meta/commit.txt
git commit -F .github/meta/commit.txt

# Tag and push
git tag v{NEXT_VERSION}
git push origin main v{NEXT_VERSION}
```

## Step 11: Monitor CI

```bash
gh run list --workflow=release.yml --repo AltimateAI/altimate-code --limit 1
gh run watch --repo AltimateAI/altimate-code
```

If fails: `gh run view --repo AltimateAI/altimate-code --log-failed`

## Step 12: Verify and Close Issues

### 12a: Verify artifacts

```bash
npm info @altimateai/altimate-code version
gh release view v{NEXT_VERSION} --repo AltimateAI/altimate-code --json tagName,publishedAt,assets
```

### 12b: Close resolved issues

Extract issue numbers from commits and PR closing references:

```bash
git log v{CURRENT_VERSION}..v{NEXT_VERSION} --pretty=format:"%s %b" \
  | grep -oE '(#[0-9]+|([Cc]loses?|[Ff]ixes|[Rr]esolves?)\s+#[0-9]+)' \
  | grep -oE '[0-9]+' | sort -u
```

For each PR, also check:
```bash
gh pr view {PR_NUMBER} --repo AltimateAI/altimate-code --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
```

For each open issue found, comment and close:
```bash
gh issue comment {N} --repo AltimateAI/altimate-code \
  --body "Resolved in [v{NEXT_VERSION}](https://github.com/AltimateAI/altimate-code/releases/tag/v{NEXT_VERSION})."
gh issue close {N} --repo AltimateAI/altimate-code
```

### 12c: Release summary

```
## Release Summary: v{NEXT_VERSION}

| Check | Status | Details |
|-------|--------|---------|
| RELEASING.md | ✅ Read | |
| Code review | ✅ | {N} SHIP, {N} HOLD — {N} P0, {N} P1, {N} P2 |
| Issues fixed pre-release | {N} | {descriptions} |
| Issues deferred | {N} | Filed as #{numbers} |
| Adversarial tests | ✅ | {N}/{N} passed |
| UX verification | ✅ | {N} scenarios passed |
| Pre-release check | ✅ | |
| Verdaccio | ✅ / ⏭️ | |
| Marker guard | ✅ | |
| CI workflow | ✅ | |
| npm | ✅ | v{NEXT_VERSION} |
| GitHub Release | ✅ | {link} |
| Issues closed | ✅ | {N} issues |

v{NEXT_VERSION} is live! No follow-up PRs needed.
```

---

## Rules

1. **Always read RELEASING.md first.** It is the source of truth for the process.
2. **Always confirm version with user.** Never auto-release without approval.
3. **Review BEFORE testing.** The multi-persona review finds design issues (stale docs, missing timeouts, naming problems). Adversarial tests find code bugs. Different tools for different problems. Review first, then test the reviewed code.
4. **Fix actionable issues before tagging.** The whole point of reviewing early is to ship clean. If the review finds a stale doc or missing timeout, fix it on main before the tag. No follow-up PRs for things that could have been fixed in 10 minutes.
5. **Only defer what truly can't be fixed quickly.** New features, large refactors, and design decisions get deferred. Missing timeouts, stale docs, wording fixes, and small guards get fixed now.
6. **Adversarial tests cover the FINAL code.** Tests run after Step 5 fixes, so they test the code that actually ships.
7. **Never skip pre-release check.** Last gate before a broken binary ships.
8. **Always use `--repo AltimateAI/altimate-code`** with `gh` commands.
9. **Only release from main.** Feature branches should not be tagged.
10. **Changelog entries must match existing style.** Bold titles with em-dash descriptions.
11. **If CI fails after push, do NOT delete the tag.** Investigate first.
12. **npm is the source of truth for versions.**
13. **PR template is mandatory.** PRs without exact headings get auto-closed. Create issue first, then PR with `Closes #N`.
14. **No `mock.module()` in adversarial tests.** Use `Dispatcher.register()`/`reset()` or `spyOn()`.
15. **Multi-persona evaluation is not optional.** The Chaos Gremlin persona must be different each release.
16. **The release is done when the summary says "No follow-up PRs needed."** If it can't say that, something was missed.
