# S1 baselines — 2026-07-18

Generated envelopes from the S1 de-fork tooling (`census.ts`, `divergence.ts`,
`replay.ts`), captured at the following refs:

| ref            | sha (12-char)   |
| -------------- | ---------------- |
| `v1.17.9` (upstream base) | `5c23e88419c4` |
| `HEAD` (ours)             | `8a50ec7f55be` |
| `v1.18.3` (replay target) | `127bdb30784d` |

## Files

- `census.json` — full marker-block inventory (`census.ts --json`). Headline:
  1146 `upstream_shared` blocks across 244 files, 228 `fork_owned` blocks
  across 84 files, 236 `fork_added_outside_boundary` blocks across 104 files
  (matching the committed `census.json` — the machine-readable source of truth).
  This is also the **ratchet baseline** wired into CI (see
  `.github/workflows/ci.yml`'s `marker-guard` job): `census.ts --check
  --baseline` compares any future census against this file as a multiset
  keyed by `{file, contentHash}` and fails only on *uncovered net-new*
  instances in the `upstream_shared` / `fork_added_outside_boundary` buckets.
- `divergence-v1.17.9.json` — diff stats between `v1.17.9` and `HEAD`, counted
  via `git diff --numstat -M -z` (git's own plumbing; matches `git --shortstat`
  exactly), broken down by taxonomy bucket (`divergence.ts --json`). Headline:
  **5283 files changed, 21162 hunks, +499181/-740989** total (349 binary, 12
  renames, 642 test files). Diff config is pinned (`diff.algorithm=myers`,
  `interHunkContext=0`, `core.quotepath=false`, `--no-ext-diff --no-textconv`,
  `GIT_DIFF_OPTS` stripped) so the numbers reproduce regardless of the runner's
  git config.
- `replay-v1.18.3.json` — object-db-only `git merge-tree --write-tree
  --merge-base` simulation of merging `v1.18.3` into `HEAD` relative to
  `v1.17.9` (`replay.ts --json`, generated **with `--census`** attribution).
  Headline: **651 conflicted paths** — of which **118 have textual content
  conflicts totalling 466 `<<<<<<<` regions**, and **4 are binary** (2 PNG, 1
  TTF, 1 WOFF2, otherwise hidden under modify/delete). Auto-merge: **212
  attempted, but only 94 truly clean** (the other 118 attempts also ended up
  conflicted — `Auto-merging` is an attempt, not proof of a clean result).

## Regeneration

All three commands are run from the repo root and require `v1.17.9` and
`v1.18.3` to exist locally (`v1.17.9` is already a local tag; fetch
`v1.18.3` first if missing — see below). None of these mutate the working
tree, the index, or any ref; `replay.ts` in particular only ever writes a
tree object via `git merge-tree --write-tree`, never a commit or branch.

```bash
# If v1.18.3 (or any other upstream tag) isn't local yet:
git fetch upstream tag v1.18.3 --no-tags

# Regenerate all three baselines (adjust the date directory as needed):
DATE_DIR=script/upstream/baselines/$(date +%F)
mkdir -p "$DATE_DIR"
bun run script/upstream/census.ts --json --ours 8a50ec7f55 --generated-at 2026-07-18T00:00:00.000Z > "$DATE_DIR/census.json"
bun run script/upstream/divergence.ts --json --ours 8a50ec7f55 > "$DATE_DIR/divergence-v1.17.9.json"
# NOTE: replay is regenerated WITH --census attribution (it rejects a census
# whose oursSha differs, so both must be at the same 'ours' ref):
bun run script/upstream/replay.ts --upstream-base v1.17.9 --ours 8a50ec7f55 --target v1.18.3 --census "$DATE_DIR/census.json" --json > "$DATE_DIR/replay-v1.18.3.json"
```

To re-point the CI ratchet at a new baseline, update the `--baseline` path
in the `marker-guard` job in `.github/workflows/ci.yml` and get the change
reviewed — a baseline bump is how new `upstream_shared` /
`fork_added_outside_boundary` marker-block instances get intentionally
"banked" rather than flagged as ratchet violations going forward.

## Notes

- `census.ts --check` only ratchets the `upstream_shared` and
  `fork_added_outside_boundary` buckets; `fork_owned` code is unrestricted
  fork territory and is excluded from the multiset entirely.
- `replay.ts`'s conflict-type strings (`modify/delete`, `content`,
  `rename/delete`, `file location`, ...) are parsed verbatim from git's own
  `CONFLICT (<type>): <text>` message text — never reimplemented — so they
  will track whatever conflict taxonomy the locally installed git emits.
  `replay.ts` refuses to run against a git older than **2.40** (the version
  that introduced `merge-tree --write-tree --merge-base`). Region counting and
  binary detection **fail closed** — a blob that can't be read throws rather
  than reporting an honest-looking zero.
- All three envelopes pin `taxonomyVersion` (from `taxonomy.ts`) and the
  resolved SHAs **and trees** of every ref they were computed against
  (`upstreamBaseTree`/`oursTree`/`targetTree`), so a consumer can detect
  staleness without re-running anything.
