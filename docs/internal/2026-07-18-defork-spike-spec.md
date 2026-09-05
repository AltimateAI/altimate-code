# De-fork Spike — Build Spec (rev 4, post-Codex rounds 1–3)

**Date:** 2026-07-18 · **Status:** rev 4 — **APPROVED for build** (Codex consensus, 4 rounds)
**Parent:** `2026-07-18-defork-feasibility-plan.md` (strategy; this spec governs build). After S1, this spec's regenerated numbers supersede the plan's §2 census table (plan gets an addendum pointer — single source of truth per topic).
**Base:** fork `main` (worktree HEAD `8a50ec7f55`). **Critical git fact (Codex-verified): the fork's history rewrite means there is NO merge-base between fork HEAD and upstream tags** — all replay/divergence math must use explicit-base three-way semantics, never a normal merge.

## 0. Engineering conventions (every stage)

- **One branch + one PR per stage** (`defork/s1-baseline-replay`, …). Each PR independently mergeable; S1–S2 have **zero product-behavior risk** (tooling/docs/tests only — S1 does change CI and adds git-state tooling, which its own tests cover). Behavior changes start at S3, behind tests.
- **Mergeability gates per PR:** marker check (`analyze.ts --markers --base main --strict`) · typecheck + affected suites green · **real-run evidence pasted in PR body** (actual tool output/transcripts/screenshots) · Codex deep review of the diff, findings addressed or explicitly waived with reason · `/consensus:code-review` · PR template (`PINEAPPLE`, Summary/Test Plan/Checklist, `Closes #N`).
- **Delegation:** Fable orchestrates + final-reviews; sonnet agents implement; Codex reviews plans + diffs adversarially; DGX optional for long batteries (S6/S7) — artifacts committed from this machine.
- **Safety rails:** replay tooling uses `git merge-tree` (object-db only, no working-tree mutation). If a stage ever needs a materialized tree: detached checkout at a resolved SHA in a `mkdtemp` dir, no branch created, hooks + rerere disabled, idempotent best-effort cleanup **plus** a `cleanup` subcommand to sweep leftovers (try/finally can't survive SIGKILL). No `git stash`.
- **Progress state:** per-stage records `docs/internal/defork-progress/s<N>.md` (avoids cross-PR conflicts on one aggregate file); orchestrator updates an aggregate only after merges.

---

## S1 — Baseline metrics + replay harness (DETAILED)

### S1.0 Shared taxonomy (used by census, divergence, replay, ratchet — one implementation)
Three buckets, computed against the **pinned upstream base tree** (`git ls-tree -r v1.17.9`), with **explicit precedence: existence in the upstream base tree wins** — a path that exists upstream is `upstream_shared` even if it sits under an approved fork root (Codex rounds 2–3: **ten** current `.opencode/` paths exist in v1.17.9 at HEAD `8a50ec7f55` — including `.opencode/.gitignore` and `.opencode/themes/.gitignore` — a dedicated unit test pins all ten and their `upstream_shared` classification; the test's oracle list is generated from `git ls-tree v1.17.9` at implementation time, not hand-copied):
1. `upstream_shared` — path exists in the upstream base tree (checked first, unconditionally).
2. `fork_owned` — not upstream, and under approved fork roots (`**/altimate/**`, `packages/drivers`, `packages/dbt-tools`, `script/upstream`, `docs/`, `.opencode/`, fork test dirs — exact list versioned in `taxonomy.ts`).
3. `fork_added_outside_boundary` — absent upstream, not under approved roots (Codex measured ~116 files / 258 marker starts currently mislabeled "shared"). **Misplacement debt**, reported separately; the ratchet blocks growth here too.

All reported totals use this taxonomy. **S1 regenerates the headline numbers** (expect true `upstream_shared` ≈ 1,140 blocks, not 1,398) and appends an addendum to the feasibility plan.

### S1.1 `census.ts`
- Stack-based block parser; **errors on unmatched start/end**; fixture/string-literal exclusions via an explicit per-block allowlist (file + line + reason), every applied exclusion reported in output — no whole-file allowlisting.
- Category rules in a versioned data table; conflicted/multi-category files carry **multiple labels** + an explicit `UNATTRIBUTED` bucket; totals reported both per-label and deduped (no pretending additivity).
- Output: versioned JSON envelope `{schemaVersion, generatorVersion, oursSha, oursTree, upstreamBaseSha, rules: {diffOptions…}, blocks:[{file, span, contentHash, description, upstreamFix, bucket, categories[]}], sortedDeterministically}`.
- Modes: `--json`, `--summary`, `--check` (ratchet, below), `--diff-budget --base <ref>` (S3 gate: added non-test LOC + files touched, split `upstream_shared` vs `fork_owned`).
- Unit tests: nesting, unmatched markers, taxonomy buckets (incl. outside-boundary), allowlist reporting, multi-category, envelope determinism.

### S1.2 Ratchet (`census.ts --check`)
Invariant: **no new marker block may appear in `upstream_shared` or `fork_added_outside_boundary` without a committed exemption** — regardless of net counts.
- **Multiset comparison** of current block set vs the committed baseline keyed by `{file, contentHash}` **with counts** (Codex round 2: duplicate identical blocks already exist, e.g. `project/project.ts:760` — plain set identity would let a removed block mask an added identical duplicate). Any identity whose count rises is a violation; per-file positive-delta and global monotonic counts remain as secondary checks.
- Exemptions: committed machine-readable `script/upstream/defork-exemptions.jsonc`, **quantity-scoped** (`{blockRef: {file, contentHash}, allowedCount, reason, approvedBy, expires?}`) — not PR-body prose.
- Wired into the existing marker-guard CI job (same invocation pattern as `analyze.ts`).

### S1.3 `divergence.ts`
- Inputs explicit: `--upstream-base v1.17.9` (must exist locally; errors with fetch instructions), `--ours <ref, default HEAD>`; records both SHAs + trees in the envelope.
- Reports, per bucket (primary = `upstream_shared`): changed files, non-overlapping hunks, added/deleted lines; pinned diff options (rename detection on, whitespace policy, zero-context hunks, binary counted separately, test-paths reported separately).
- Fixture-tested diff parsing.

### S1.4 `replay.ts` — explicit-base three-way merge (Codex contract adopted)
- Inputs: `--upstream-base v1.17.9 --ours <ref, default HEAD> --target v1.18.3`. Resolves + records all three SHAs/trees.
- Engine: `git merge-tree --write-tree --merge-base <upstream-base> <ours> <target>` (object-db only; no worktree, no branch, invoking checkout untouched). Validated on a fixture repo first (merge-tree conflict-output parsing is version-sensitive — pin/verify git version behavior in a test).
- Counts separately: conflicted paths · textual conflict regions · modify/delete · binary · rename · submodule conflicts. Attribution joins census blocks by file, **rejecting a census file generated from a different `ours` SHA**.
- KPI language fix (parent plan edited): the replay measures **conflict surface**, not "resolution time." Resolution time becomes a separately-timed human/agent resolve-and-validate exercise run at wave ends only.
- Real first run: `v1.18.3` (fetch tag), committed to `script/upstream/baselines/2026-07-18/`.

### S1 deliverable summary
`taxonomy.ts`, `census.ts`, `divergence.ts`, `replay.ts`, tests, baselines dir, exemptions file (empty), CI ratchet wiring, regenerated headline numbers + plan addendum. **E2E evidence:** real outputs of all three tools pasted in PR. Estimated ~800–1,100 LOC tooling+tests, zero product-behavior risk.

---

## S2 — Execution-route inventory + sentinel tests (DETAILED, Codex contract adopted)

1. **Separate ingress surfaces from execution dispatchers.** Ingress: CLI `run`, TUI, server v1 routes, server v2 HttpApi, ACP, GitHub/GitLab handlers. Dispatchers (the things HardPolicy must cover): `session/tools.ts` resolver wrapper, `session/prompt.ts` parallel resolver, **BatchTool's direct registry execution (`tool/batch.ts:104` — bypasses both wrappers)**, **direct Task dispatch in `session/prompt.ts:580`**, MCP wrapper path, plus anything discovered (debug/internal direct calls).
2. **Route states:** `active` / `latent` (e.g., `SessionTools.resolve` currently has no production consumer at HEAD — verify) / `out-of-scope` (plugin-init code, `shell.env`, server config-mutation endpoints — the "arbitrary code outside HardPolicy's model-invoked boundary" section, consistent with the parent's scope).
3. **Executable sentinel tests, not `test.todo`:** each `active` route gets a harmless sentinel tool invocation driven end-to-end through that route, asserting execution reached the dispatcher (spy/probe). An unproven `active` route fails the S2 gate. Latent routes get a "latent, becomes active if wired" note + a guard test that flips when they gain a consumer.
4. Deliverables: `docs/internal/defork-route-matrix.md` (routes × {dispatcher, file:line chain, ctx.ask?, Ruleset applied, reachable-under-allow-all}) + `test/altimate/defork/route-sentinels.test.ts` (executable). Product code untouched.

---

## S3 — HardPolicy prototype (DETAILED — kill gate; Codex contract adopted)

**Versioned rule table (v1), matching TODAY's behavior — no silent product changes (semantics pinned by Agent-level runtime-composition tests, not isolated merge tests — Codex round 2):**
- v1 scope = the current *true* hard blocks, both promoted to HardPolicy as behavior-preserving:
  1. `sql_execute` (tool ID — note `sql_execute_write` is a permission ID, not the tool) DDL block (`DROP DATABASE/SCHEMA`, `TRUNCATE`) currently enforced inside `altimate/tools/sql-execute.ts:24`.
  2. **Bash DDL deny** — `agent.ts:165` appends safety *denials* AFTER user config (deny-level, not ask; asserted by `test/altimate/carry-forward/agent-safety.test.ts:84`).
- `rm -rf` / `git push --force` remain **ask-level Ruleset** entries exactly as today (`agent.ts:154`), user-overridable. The correct current-behavior boundary (ask-tier vs deny-tier, and exactly which patterns sit in each) is pinned FIRST by new Agent-level tests that exercise the real Agent composition path (user config merged, safety denials appended) — those tests are the ground truth the HardPolicy migration must keep green.
- Any escalation to unconditional deny = a **flagged product decision for Anand**, listed in the S3 PR under "behavior changes: none (v1)" / a proposed-v2 table.
- Rule table format: `{ruleID, toolID, argExtractor, action: "deny", positiveExamples[], negativeExamples[]}` — versioned, each example an executable test case.
- **Safe-control tests:** for every route × rule, a *near-miss allow* case (e.g., `DROP TABLE` where only `DROP DATABASE` is denied; `SELECT` runs) — an implementation that denies everything fails the suite.

**Enforcement mechanics:**
- `packages/opencode/src/altimate/policy/hard-policy.ts`: pure, synchronous, **total** — malformed args or classifier failure ⇒ deny with `policy_internal_error` (never throw, never implicit allow).
- **Placement:** at each dispatcher identified by S2 — including the Batch inner dispatch (check at the inner per-tool dispatch point, not by recursively parsing batch payloads at the outer edge) and the direct Task path.
- **Final-args snapshot:** capture the value returned by `tool.execute.before` and pass the *same snapshot* to both HardPolicy and execute. Codex-verified today's resolvers ignore the hook's `output.args` (they keep using the local variable) — S3 fixes that plumbing as part of the seam (and it's an `upstream_fix` PR candidate).
- **Denial shape:** stable `{code: "hard_policy_denied", ruleID, safeReason}`, `metadata.success=false`, model-facing text, user-visible state; assert underlying execute and `tool.execute.after` are NOT called.
- **Fail-closed init:** eager init at the app-runtime composition seam (`effect/app-runtime.ts:55` candidate); invalid init ⇒ composition failure (library code does NOT call `process.exit`); test that server readiness/session startup is unreachable after invalid init.
- **Budget (executable):** measured by `census.ts --diff-budget --base main` on the S3 branch — added non-test LOC in `upstream_shared` files ≤ **100** (reserving 50 of the parent's 150 for S7), `upstream_shared` files touched ≤ 3. Fork-owned policy-module LOC unbudgeted.
- **Kill rule:** if S2's route map can't be covered within budget → STOP, post findings; status quo remains (nothing lost).

**E2E/visual:** scripted real session (TUI screenshot + headless transcript): `DROP DATABASE` via sql tool → denied with proper surfacing; near-miss `DROP TABLE` (allowed rule-wise) → proceeds to normal permission flow; server-API session attempt transcript.

---

## S4–S10 outline (mini-spec at PR time, informed by upstream stages)

- **S4** Prebundled AltimatePlugin skeleton (internal-plugin path, one marker; deterministic ordering; duplicate-tool-ID policy; offline test; required-init failure ⇒ composition failure, optional ⇒ loud degrade).
- **S5** 3 pilot tools via plugin (`schema-inspect`, `sql_execute`, `dbt-manifest`) with golden transcript parity incl. HardPolicy + subagent + server paths; produces the migration recipe. Golden captures created here (deferred from S1 by design — parent plan updated to match).
- **S6** Telemetry event-consumer + golden-diff battery (DGX candidate); residual call-site list.
- **S7** Validator continuation: adversarial harness vs `session.idle` (100 trials, DGX candidate); awaited `session.turn.complete` core hook within the reserved 50-LOC budget; exactly-once or validators stay fork-side.
- **S8** Separate `altimate.json` + MCP discovery via plugin; provider/auth classification.
- **S9** Branding exact-match external patch + dist leakage scan + snapshots. **Branches only after all measured stages merge** (its replay delta must reflect them); not parallel with S5.
- **S10** Decision: block-by-block carrier map, 7 gates from the parent plan, GO/NO-GO.

**Sequencing:** S1→S2→S3 serial. Post-S3: S4→S5 serial; S6/S8 may parallel S5; S7 after S4; S9 after measured stages merge; S10 last. Anand review checkpoints: S3, S7.

## Consensus log

- Round 1 (Codex): CHANGES REQUIRED — 7 blockers (replay merge-base invalidity; taxonomy mismatch; ratchet identity-based detection; route matrix active/latent + Batch/Task bypasses + executable sentinels; v1 rules vs actual current behavior; enforcement/failure contract gaps incl. output.args plumbing; budget/independence executability). **All adopted in rev 2 above.** NITS adopted: golden-capture note synced to parent plan; divergence diff-option pinning; census unmatched-marker errors + allowlist reporting; multi-category; "zero product-behavior risk" wording; `agentID`/`callID` semantics to be pinned in S3 rule table (callID optional today).
- Round 2 (Codex): CHANGES REQUIRED — 3 blockers: taxonomy precedence for upstream/.opencode overlap (8 paths); multiset ratchet identity + quantity-scoped exemptions; v1 rule table wrong about bash DDL (it IS deny-level today, appended after user config) + pin semantics via Agent-level tests. **All adopted in rev 3.**
- Round 3 (Codex): CHANGES REQUIRED — 1 blocker: overlap set is 10 paths not 8 (adds `.opencode/.gitignore`, `.opencode/themes/.gitignore`). **Adopted.** Multiset ratchet + v1 rule table confirmed genuine.
### S1 build review (Codex deep review of implementation, 2026-07-18)
- Round 1 of S1 CODE review: **CHANGES REQUIRED — 16 blocking** (census read dirty FS not the pinned tree → false provenance + wrong totals; divergence `+++/---` parser ate ~10,870 real deletions; replay counted conflict messages not textual regions + "auto-merged" overcounted; literal NUL bytes in census.ts; shell-injection in refs.ts; unmatched markers silently counted not errored/allowlisted; tests blessed wrong behavior). All handed back to the builder as a fix order; corrected numbers pinned (divergence 5,283 files +499,181/−740,989; replay 466 regions across 118 files, 94 clean auto-merges). Codex CONFIRMED correct: 10-path .opencode oracle, centralized taxonomy precedence, multiset ratchet multiplicity, explicit-base replay command, oursSha rejection, CI ordering.
- Round 2 of S1 CODE review: PENDING after fixes.

- Round 4 (Codex): **CONSENSUS: APPROVED** (2026-07-18). Watch-items for S1 builder: (1) overlap oracle generated from `git ls-tree -r v1.17.9`, both `.gitignore` paths verified `upstream_shared`; (2) taxonomy precedence centralized in `taxonomy.ts`, reused unchanged by census/divergence/replay/ratchet; (3) provenance + determinism — pin resolved SHAs/trees, reject census/replay SHA mismatches, multiset-count ratcheting.
