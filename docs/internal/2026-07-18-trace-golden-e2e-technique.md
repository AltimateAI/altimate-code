# Trace-Golden E2E: using the fork's own trace subsystem as the integration-test oracle

**Date:** 2026-07-18 · **Status:** technique spec (build target), **revised after Codex review** · **For:** de-fork spike verification **(S5 observable parity, S7 continuation invariants)** and general regression safety — **NOT an S3 security oracle** (see box).

> **⚠️ Codex review correction (2026-07-18, verified in code) — scope + design changes:**
> 1. **Not a security oracle.** The trace has no deny status (`TraceSpan.status` is only `ok|error`), config denials throw `DeniedError` without emitting permission events, `tool.execute.before/after` are plugin calls not spans, and tracing is best-effort/failure-suppressing — so **absence of an execute span is not proof of non-execution**. S3's HardPolicy kill-gate uses an independent structured audit probe + dispatcher counters; the trace only *corroborates* user-visible surfacing.
> 2. **Partial-order matching required.** Spans append on completion (not start), Batch runs children with `Promise.all`, and 6 of 102 real local traces already show sibling order inversions. The matcher totally-orders only deliberately-serial scenarios; concurrent siblings compare as a keyed multiset/DAG.
> 3. **Normalizer = versioned allowlist projection, not a scrub blacklist.** Every field explicitly classified; unknown fields fail until classified. The trace is deliberately lossy (truncation, 10K output cap, elision) so "no diff" ≠ full behavioral equivalence.
> 4. **A zero-diff does not prove the route.** Native and plugin tools look identical in the trace by design — so S5 parity checks must pair the golden with a separate dispatcher sentinel proving the intended route actually ran.
> 5. Driver = real subprocess fixture (`test/lib/cli-process.ts`) + test LLM server (`test/lib/llm-server.ts`, deterministic call IDs); run each scenario 50–100× to prove hash stability under load before accepting a golden; `--update` disabled in CI.

## The idea

The fork already records every session as a **span tree** (`~/.local/share/altimate-code/traces/ses_*.json`): each span has `{spanId, parentSpanId, name, kind, input, output, status, startTime, endTime}`, plus a `summary {totalToolCalls, topTools, tokens, narrative}`. This is a complete, structured record of what a session *did* — the tool-call topology, the order, the inputs/outputs, and (critically for de-fork) permission/deny events.

**So the trace IS the behavioral oracle.** Instead of asserting on a function's return value (unit-level, misses integration), we:
1. Drive a **real headless session** end-to-end with a deterministic prompt + a **scripted model** (fixed tool-call sequence, no network).
2. Capture the trace the session emits.
3. **Normalize** out nondeterminism (timestamps, spanIds, costs, abs paths, durations, host).
4. **Diff the normalized span topology** against a committed golden.

A change in observable behavior = a diff in the golden. A tool moving from native→plugin (S5) that changes nothing observable produces an identical golden. A `DROP DATABASE` that should be blocked produces a `hard_policy_denied` span — the deny is **in the trace**, so the golden proves enforcement end-to-end, through whatever route the session took, not just at the unit that implements it.

## Why this is the right oracle for de-fork specifically

- **Route-agnostic:** the trace captures the actual execution path (native resolver, plugin tool, batch, subagent). If S3's HardPolicy has a hole on one route, a golden driving that route shows an un-denied span. This is the executable complement to S2's static route matrix.
- **Refactor-invariant:** de-fork is "move code, change nothing observable." Return-value tests are brittle to internal shape changes; span topology is the invariant the user actually experiences.
- **Parity by construction:** S5 migrates a tool to a plugin — record golden on native, switch to plugin, diff. Zero-diff = parity proven. Any diff is exactly the behavior change to explain.
- **Permission events are first-class:** the deny path emits a span/status; goldens assert denies happened AND that `execute`/`tool.execute.after` did NOT (absence of the execute span).

## Architecture

```
packages/opencode/test/altimate/trace-golden/
  driver.ts          # spins a headless session with a scripted model + captures its trace
  normalize.ts       # deterministic scrub (timestamps→0, spanId→ordinal, paths→<REPO>, cost→0, sort stable)
  match.ts           # structural diff normalized-actual vs golden; pretty conflict output
  scenarios/         # one dir per scenario: prompt.json + model-script.json + golden.json
    drop-database-denied/
    sql-select-allowed/
    tool-native-vs-plugin-parity/   (S5)
    validator-inject-continue/       (S7)
  trace-golden.test.ts  # runs every scenario dir, asserts match; --update regenerates goldens
```

### Scripted model (determinism source)
Reuse the fork's existing test-CLI / fake-provider path (ci.yml references an `OPENCODE_TEST_CLI` scriptable harness; `tracing-e2e.test.ts` shows the `Recap` API). The model script is a fixed list of assistant turns: text + tool calls with exact args. No LLM, no network → byte-stable except the nondeterminism `normalize.ts` strips. If no reusable fake provider exists, the driver registers a stub provider returning the scripted turns (smallest viable: a provider plugin that replays a JSON script).

### Normalization contract (must be exhaustive or goldens flap)
Strip/canonicalize: `startTime`/`endTime`/`duration`→omitted; `spanId`/`parentSpanId`→ordinal by DFS order; `traceId`/`sessionId`→`<SID>`; costs/tokens→bucketed or omitted; absolute paths→`<REPO>`; tmp dirs→`<TMP>`; env/host fields dropped; arrays that are set-like sorted by a stable key. Keep: span `name`, `kind`, `status`, tool `input`/`output` (with volatile sub-fields scrubbed), parent/child structure, sibling order where order is semantic.

### Match output
On mismatch: print the minimal structural diff (added/removed/changed spans by path), not a 600KB blob. Exit nonzero. `--update` writes the normalized actual as the new golden (human reviews the diff in the PR — goldens are reviewed artifacts, like snapshots).

## De-fork stage hooks

- **S3 (HardPolicy):** scenarios `drop-database-denied` (every route: bash, sql tool, MCP, batch-wrapped, subagent), `drop-table-allowed` (near-miss control), `user-config-allow-all-still-denied`. Golden asserts the deny span present and execute span absent. These are the S3 kill-gate's executable proof, and they double as the bypass matrix's runtime arm.
- **S5 (tool migration):** record golden with native tool → flip the tool to plugin → same golden must pass. Repeat per migrated tool; the recipe.
- **S7 (validator continuation):** scenario where a failed dbt validation must produce an injected follow-up turn + continuation, exactly once — the trace shows the extra generation span; concurrency variants assert no double-inject.

## Inspiration from the past upstream-merge traces

The `~/.local/share/altimate-code/traces/` store (100+ sessions) and the downloaded merge-session bundles (`~/Downloads/handover-bundle/A3_altimate-code-traces/`, `~/Downloads/altimate-code-traces/`) are **real recorded sessions from actual work incl. the v1.17.9 merge**. Uses:
1. **Realistic scenario seeds:** mine them for the actual tool-call sequences real sessions produce (which tools, what order, how permissions surfaced) → scenarios grounded in real usage, not invented.
2. **Schema ground truth:** they define the exact span shape the normalizer must handle (kinds, status values, de-attributes) — build `normalize.ts` against real files, not a guess.
3. **Regression corpus:** replay-normalize a sample of them through the pipeline to confirm the normalizer is stable (same session → identical normalized output across runs) before trusting goldens.

## Guardrails
- Goldens are committed, reviewed artifacts; `--update` diffs go in the PR body for human sign-off.
- Scenarios are hermetic: no network, no real warehouse, temp HOME, scripted model. A scenario that can't be made deterministic is not a trace-golden scenario (use a unit test).
- Keep the corpus small and load-bearing (each scenario must pin a behavior a de-fork stage could break), per the no-slop test rule.
