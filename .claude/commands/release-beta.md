---
description: Cut a BETA (prerelease) of altimate-code to the npm `beta` channel. Existing `latest` users are NOT auto-upgraded — only opt-in beta testers get it. Use to soak a risky change (e.g. a big upstream merge) before promoting to `latest` with /release.
---

# Release altimate-code BETA

Cut a prerelease to the **`beta`** npm dist-tag. The whole point: **existing
stable (`latest`) users are never touched.** Only people who opted into the
beta channel (`npm i -g @altimateai/altimate-code@beta`, or a beta install)
receive it. Use this to dogfood a risky release before promoting it to
`latest` with `/release`.

## Why this is a separate skill (read once)

- `/release` tags a plain `vX.Y.Z` → the workflow publishes to **`latest`** →
  **every existing user auto-upgrades on next launch.** For a big/risky change
  that is exactly the "brick everyone if there's a bug" risk.
- A beta tag has a `-` suffix (`vX.Y.Z-beta.N`). `.github/workflows/release.yml`
  derives `OPENCODE_CHANNEL` from the tag: a `-` → the **`beta`** channel →
  `npm publish --tag beta`. The `latest` dist-tag is left pointing at the old
  stable, so `latest` users do not move.
- The upgrade check (`cli/upgrade.ts`) is fail-safe and orders prerelease
  identifiers, so a beta tester on `beta.1` auto-upgrades to `beta.2`, and any
  beta upgrades to the eventual stable. This is verified by the round-trip below.

## Input

`$ARGUMENTS` = the target STABLE version this beta leads to (`patch` | `minor` |
`major`, or an explicit `X.Y.Z`). Default `minor` — a big upstream merge is not
a patch. The beta tag becomes `vX.Y.Z-beta.N`.

---

## Step 1 — Determine the beta version

```bash
# current published STABLE (the latest dist-tag)
npm view @altimateai/altimate-code dist-tags --json
```

- Base stable `X.Y.Z` from `$ARGUMENTS`:
  - `patch`/empty → not typical for a beta; prefer `minor`.
  - `minor` → bump minor of the current stable (0.8.10 → **0.9.0**).
  - `major` → 0.8.10 → **1.0.0**.
  - explicit `X.Y.Z` → use it.
- Find the next `-beta.N`: look at the current `beta` dist-tag. If it is already
  `X.Y.Z-beta.M`, next is `beta.(M+1)`; otherwise start at `beta.1`.

```bash
# does a beta for this base already exist?
npm view @altimateai/altimate-code@beta version 2>/dev/null || echo "no beta yet"
```

Confirm with the user: **"Cutting beta `vX.Y.Z-beta.N`. This publishes to the
`beta` channel only — `latest` stays at `<current stable>`, so existing users
are NOT auto-upgraded. Proceed?"** Wait for an explicit yes.

## Step 2 — Ensure clean, correct base

```bash
git branch --show-current       # expect main (or the branch you're betaing)
git status --short              # must be clean
git fetch origin
git log HEAD..origin/$(git branch --show-current) --oneline   # must be up to date
```
Stop if dirty, behind, or on an unexpected branch.

## Step 3 — Pre-tag gates (lighter than /release, but non-negotiable)

Betas soak in production, so they must at least build and pass CI. Do NOT skip:

```bash
# both packages typecheck
(cd packages/opencode && bun run typecheck)
(cd packages/tui && bun run typecheck)
# marker guard
bun run script/upstream/analyze.ts --markers --base main --strict
# PR/branch functional CI is green
gh pr checks <PR> --repo AltimateAI/altimate-code | grep -viE 'kilo|coderabbit|skipping'
```
If any functional gate is red, stop and fix first.

## Step 4 — Tag and push the beta

The `-beta.N` suffix is what routes to the beta channel. Do NOT omit it.

```bash
BETA_TAG="vX.Y.Z-beta.N"
git tag "$BETA_TAG"
git push origin "$BETA_TAG"     # push the TAG (not necessarily main)
```

Note: unlike `/release`, do not `git push origin main` unless main already
contains this commit. A beta can be tagged on a branch or on main; the tag is
what triggers the workflow.

## Step 5 — Monitor the release workflow

```bash
gh run list --workflow=release.yml --repo AltimateAI/altimate-code --limit 1
gh run watch --repo AltimateAI/altimate-code
```
The workflow's native linux-x64 smoke + pre-publish smoke are the last gates.
If it fails, do NOT delete the tag — investigate (`gh run view --log-failed`).

## Step 6 — CRITICAL post-publish guard: confirm `latest` did NOT move

This is the safety assertion. After publish:

```bash
npm view @altimateai/altimate-code dist-tags --json
```

- `beta` MUST now be `X.Y.Z-beta.N`.
- `latest` MUST be UNCHANGED (still the previous stable, e.g. 0.8.10).

If `latest` moved to the beta version, **the beta leaked to all users** — treat
as an incident: publish a corrected `latest` dist-tag back to the last-good
stable immediately (`npm dist-tag add @altimateai/altimate-code@<good> latest`)
and investigate the channel derivation in release.yml.

## Step 7 — Verify the beta works AND can upgrade out (round-trip)

The whole reason for a beta is to prove the new codebase is safe — including
its own auto-upgrade — before stable users touch it.

```bash
# install the beta hermetically (does not touch your normal install if you use a temp prefix)
npm i -g @altimateai/altimate-code@beta   # or an isolated prefix
altimate --version                        # reports X.Y.Z-beta.N
altimate agent list; altimate skill list  # fork surfaces load
```

Dogfood real workflows on the beta. Then prove the **round-trip**: when you cut
`vX.Y.Z-beta.(N+1)`, a machine already on `beta.N` must auto-upgrade to it on
next launch (compareVersions orders betas). If it does, the updater on the new
codebase is proven — stable users can safely be promoted onto it.

## Step 8 — Promote to `latest` (separate, deliberate step)

Only after the beta has soaked and the round-trip is proven:

- Run **`/release {same bump}`** to cut the stable `vX.Y.Z` → `latest`. That is
  the step that auto-upgrades existing users — and by then you've proven the
  exact code and its updater on the beta channel.
- Do NOT move `latest` to a `-beta` version by hand; ship a clean stable tag.

---

## Hard rules

- The tag MUST contain `-beta.N`. A plain `vX.Y.Z` from this skill would hit
  `latest` — never do that here.
- Never skip Step 6 (the `latest`-didn't-move assertion). It is the one check
  that catches a channel-routing regression before it bricks everyone.
- npm publishes are effectively irreversible — get the explicit user yes at
  Step 1 before tagging, and never publish credentials or move `latest` without
  intent.
