# driver.ts discovery trail

Referenced from `driver.ts`'s header comment. This documents how the driver
was built, what existing infrastructure it reuses, and two real bugs the
normalizer had that only surfaced by actually running the driver multiple
times against a live subprocess.

## Scope: what this technique is (and is not) for

Trace-golden is scoped to **S5 behavioral parity** (does a session driven
end-to-end still produce the same shape of work after a de-fork/upstream
change?) and **S7 continuation** (regression coverage on later stages that
build on top of the same driver/normalizer plumbing). It is a snapshot-diff
tool over an observability trace, nothing more.

**It is explicitly NOT a security or HardPolicy enforcement oracle**, and
must never be used or cited as one. Reasons, confirmed in code during this
harness's construction:

- `TraceSpan.status` is only `ok | error` — there is no denial/blocked
  status, so a HardPolicy deny has no distinct trace representation to
  assert on.
- `logToolCall` and the tracer generally are best-effort and
  failure-suppressing (see `match.ts`'s header comment on partial-order
  matching for the concurrency half of this same fragility). A missing or
  reshaped span can mean "correctly denied," "tracer swallowed an error," or
  "unrelated normalizer/timing flake" — those are indistinguishable from the
  trace alone, so **absence of an execute span is not proof of
  non-execution**.
- Golden-diffing is inherently a UX/shape corroboration signal (does the
  user-visible surface look right), not a proof that a dispatcher was
  actually short-circuited before a side effect ran.

For anything security-relevant (e.g. S3's HardPolicy kill gate), the
correct oracle is an independent structured audit probe emitted by the
policy check itself plus dispatcher execute-counters — see
`scratchpad/s3-build-brief.md`'s "Tests (the kill-gate proof)" section. A
trace-golden scenario may exist alongside that as a corroborating UX check
(e.g. confirming a denied tool call surfaces a sane error to the model/user)
but must always be paired with the audit-probe assertion, never relied on
by itself.

## 1. Finding a scriptable session harness (no new fake provider needed)

The technique spec calls for driving "a real headless session with a
deterministic prompt + scripted model." Before building anything new, we
searched the repo for an existing deterministic test harness and found one
already used by the CLI's own test suite:

- `packages/opencode/test/lib/cli-process.ts` — `withCliFixture()` spins up an
  isolated `CliFixture` (its own `HOME`/XDG dirs, own config, own git-free
  workspace) and exposes `fixture.opencode.run(prompt, opts)` to invoke the
  real `opencode` CLI binary as a subprocess, plus `fixture.llm` bound to a
  `TestLLMServer`.
- `packages/opencode/test/lib/llm-server.ts` (via `test-provider.ts`) — a
  scriptable fake LLM endpoint. `llm.text(str)` queues a plain assistant
  reply; `llm.tool(name, input)` queues a tool-call turn. The CLI subprocess
  talks to this local server instead of a real provider, giving us fully
  deterministic model output without mocking anything inside the CLI itself.

`driver.ts`'s `driveScenario()` is a thin composition of these two pieces:
push every `ScriptedTurn` from the scenario's `model-script.json` onto
`fixture.llm`, call `fixture.opencode.run(prompt, { format: "json", ... })`,
then recover the trace file path from the `trace_saved` JSON event the CLI
emits on exit (`src/cli/cmd/run.ts`) — no directory-convention guessing, no
polling `~/.local/share/altimate-code/traces/` for the newest file.

## 2. `--dangerously-skip-permissions` is required for a non-interactive driver

Without it, `opencode run` defaults every permission ask (e.g. for `read`) to
`"ask"`, which an in-process run with no TUI and no connected client to
answer can never resolve — the session just hangs. `--dangerously-skip-permissions`
auto-approves anything not explicitly denied (see the yolo-mode branch in
`src/cli/cmd/run.ts`). This is passed via `runOpts: { extraArgs: [...] }` in
the smoke scenario's test.

## 3. `HOME` env vs `os.homedir()` — a normalization gotcha

`isolatedEnv()` in `cli-process.ts` sets the child subprocess's `HOME` (and
related XDG vars) to the fixture's own tmp-created home directory, and also
sets the subprocess's `cwd` to that same directory. That means every
home-relative path inside the driven session's own trace is
`fixture.home`-rooted, NOT this test process's `os.homedir()`. `normalize()`
defaults `homeRoots` to `[os.homedir()]`, so calling it on a driven-session
trace without overriding `homeRoots` silently no-ops on every path in that
trace. The test passes `normalize(result.trace, { homeRoots: [fixture.home] })`
explicitly to fix this.

## 4. Two real normalizer bugs found by running the driver more than once

The first `golden.json` was generated via `TRACE_GOLDEN_UPDATE=1` and looked
correct on inspection. Re-running the exact same scenario immediately after
(no code changes, same script, same prompt) — as a sanity check before
trusting the golden — failed with a 7-diff mismatch. Two consecutive real
subprocess-driven sessions naturally produce different random session IDs,
different random tmp-dir names (`fixture.home` has a random per-run suffix),
and different random generation part-IDs, and the pre-fix normalizer didn't
fully scrub any of these:

**Bug A — path-scrubbing order dependency.** The original `normalize.ts` ran
three *separate* passes over each string: a `tmpRoots` pass, then a
`repoRoots` pass, then a `homeRoots` pass. `fixture.home` is itself created
*inside* the OS tmp dir with a random per-run suffix, e.g.
`/private/var/folders/.../T/oc-cli-Wp3D9s`. The default `tmpRoots` list
contains the generic, shorter prefix (`os.tmpdir()`, `/private/tmp`, etc.).
Because the tmpRoots pass ran first, it consumed just the generic prefix and
replaced it with `<TMP>`, leaving the random `oc-cli-Wp3D9s` suffix exposed
as literal, nondeterministic text in every path in the trace — by the time
the homeRoots pass ran, the string had already been mutated so the full
`fixture.home` path no longer matched as a contiguous substring.

Fix: replaced the three separate passes with a single merged, **longest-root-
first** pass (`buildRootEntries` / `RootEntry` in `normalize.ts`). A root
from one category can be a strict prefix of a root from another category
(home-inside-tmp is exactly this case), so the more specific (longer) root
must always be tried — and win — before the more generic (shorter) one it
happens to live inside.

**Bug B — non-path random IDs leaking through span names.** `kind: "session"`
spans are named `metadata.instance_id || sessionId` (`src/altimate/
observability/tracing.ts` ~L600) — the trace's own random `ses_...` id.
`kind: "generation"` spans are named `` `generation-${part.id}` `` (~L798),
where `part.id` is a random-per-run `prt_...` id. Neither is a filesystem
path, so no path-scrubbing pass ever touched them, and they flapped on every
run independent of Bug A.

Fix: added `scrubSpanName()` with `SESSION_NAME_PATTERN` /
`GENERATION_NAME_PATTERN` to canonicalize these two span-name shapes
(`"<SID>"` and `"generation"` respectively) before they reach the diff.

**Verification (original, 3 runs, pre-rework normalizer).** After both fixes:
deleted the stale golden, regenerated it once, then ran the full suite 3
additional independent times (each a fresh real `opencode run` subprocess
with new random IDs). All 3 passed with zero diffs, confirming the golden is
stable across genuinely different process runs — not just stable because it
was compared against itself.

This is exactly the failure mode the technique spec's normalization-contract
section warned about ("must be exhaustive or goldens flap"). It was only
caught by actually driving the scenario multiple times rather than trusting
a single golden-generation run — a single run has no way to distinguish
"correctly normalized" from "coincidentally matched its own random IDs."

## 5. Stability under load — 100 independent runs (post-rework: partial-order matcher + allowlist normalizer)

3 runs is not enough to trust a golden — it's enough to catch a bug that
flaps most of the time, not one that flaps rarely. After `match.ts` was
rewritten to partial-order/rank-aware diffing and `normalize.ts` was rewritten
to a versioned allowlist projection (see the top-level technique doc), the
smoke scenario's golden was regenerated under the new normalizer and then
re-verified against **100 fully independent runs**:

```
bun run test/altimate/trace-golden/stability-check.ts 100 6
```

`stability-check.ts` (new standalone script, sibling to this file — deliberately
NOT a `*.test.ts` file so `bun test` never picks it up automatically) drives
the `smoke` scenario 100 times, each through its own independent `CliFixture`
(own random-suffixed tmp home dir, own `TestLLMServer`, own `opencode run`
subprocess — never reusing one fixture across drives, since Bug A above only
manifested because of that exact per-run randomness), and compares the
`stableStringify(normalize(trace))` output across all 100 runs plus the
committed golden.

Result:

```
runs requested:   100
runs succeeded:   100
runs failed:      0
unique hashes:    1 (1 = fully stable)
matches golden:   true
total wall time:  46.6s
avg run time:     2763ms
```

100/100 runs produced a byte-identical normalized hash, and that hash matches
the committed `scenarios/smoke/golden.json`. This meets the bar of proving
stability under load rather than trusting a single (or triple) golden-
generation run. `stability-check.ts` is intentionally opt-in only (not wired
into `bun test` or CI) — see its header comment for why, and for how to
re-run it (e.g. after normalizer changes, before accepting a new golden).
