# Retrospective: why review + regression tests missed user-facing bugs (v1.17.9 merge)

Written 2026-06-25. Trigger: after consensus code review, codex PR review, full CI, and a manual E2E
pass, the user ran the build and immediately hit two showstoppers — the **TUI was unusable** (server
logs flooded the screen) and **the logo rendered in caps** — plus an earlier-found **TUI tracing**
regression. None of our gates caught them. This is the "why" and the "how to catch more."

## 1. What slipped through, and which gates each passed

| Bug | Severity | Passed: consensus review | codex review | CI (typecheck/test/marker/DriverE2E/CodeRabbit/Kilo) | my manual E2E |
|---|---|---|---|---|---|
| TUI log flood (TUI unusable) | P0 | ✅ missed | ✅ missed | ✅ missed | ✅ missed (I tested commands+TUI render but not "is stderr clean") |
| TUI session tracing dropped | P1 | ✅ missed | ✅ missed | ✅ missed — a test PASSED while the feature was gone | caught (only because I checked for a trace file) |
| InstanceRef "not provided" | P1 | n/a | n/a | merge tests green | caught late, deep manual dig |
| Auth username mismatch | P1 | — | **caught (P1)** | — | — |
| Logo in caps | P3 | missed | missed | missed | missed |
| DB migration race | P1 (flaky) | — | — | **caught (flaky CI)** | — |

The two gates that ever caught anything: codex review (auth) and CI flakiness (DB race). Everything
that made the product **unusable when run** sailed through every gate.

## 2. Root cause — we gate CODE, not the RUNNING ARTIFACT

Every missed P0/P1 has the same shape: it is invisible in any single diff and in any isolated module
test; it only appears when the **real entrypoint runs and a human uses it**. Concretely:

1. **Reviews read diffs → can't see emergent behavior.** The log flood is the *interaction* of three
   things in three files: the shim defaulting `printEnabled=true`, the TUI running the server
   in-process, and the entrypoints no longer calling `Log.init`. No single hunk looks wrong. Diff
   review structurally cannot catch cross-file emergent runtime behavior.
2. **Unit/integration tests test PARTS, not the shipped whole.** `trace-consumer` tests pass (the
   consumer logic is fine and was preserved). But nothing launched the TUI and asserted "a trace file
   appears" or "the screen has no log lines." We tested the engine, never the car.
3. **Tests assert ABSENCE, not PRESENCE (false green).** `worker-trace-clearing.test.ts` asserts the
   OLD trace logic is gone — and it dutifully passed while the NEW wiring was *also* gone, i.e. while
   tracing was completely dead. A test that can be green when the feature is deleted is worse than no
   test: it's a false guarantee.
4. **CI never exercises the TUI or the compiled binary's interactive surfaces.** typecheck + bun unit
   tests + Driver E2E (warehouse drivers) + marker guard. The single most important and most fragile
   surface — the interactive TUI — has **zero** automated coverage. Logging, tracing, branding, and
   the in-process server all converge there.
5. **Every upstream merge rewrites the entrypoints, silently dropping fork hooks.** `worker.ts`,
   `index.ts`, and `serve.ts` get re-extracted upstream; our customizations that hooked into them
   (the `Log.init` calls, the trace-consumer wiring) vanish with no compile error and no failing test.
   There is no "this hook MUST be present" guard.
6. **Marker guard tracks MARKED code, not FUNCTIONING features.** Deleting a feature needs no markers,
   so a dropped feature is invisible to the marker analyzer. Markers protect code that *survives*;
   they say nothing about code that was *removed*.

**The meta-gap:** strong CODE-level gates (review, typecheck, markers, isolated unit tests), nothing
at the ARTIFACT / USER-JOURNEY level. The user found all of these in ~60 seconds by doing the one
thing none of our automation does: build the real thing and use it.

## 3. How to catch more — the strategy

Principle: **don't only prove code is correct in isolation — prove the SHIPPED ARTIFACT behaves
correctly when RUN, and that every fork feature is PRESENT and FUNCTIONING (not merely that old code
is absent).**

### A. Entrypoint smoke tests that assert observable output  — SHIPPED
`test/cli/smokes/output-hygiene.test.ts` spawns the real CLI entrypoint and asserts what a human sees:
- `skill list` is **quiet by default** (no `service=` / `[INFO]` on the terminal) → catches the log
  flood class.
- no `InstanceRef not provided` → catches the InstanceRef ALS class.
- `--print-logs` still streams logs → the opt-in can't silently break.
Plus `test/altimate/log-shim.test.ts` unit-guards the shim's quiet-by-default contract.

### B. TUI pty end-to-end  — HIGHEST-VALUE REMAINING (to build)
Launch the TUI via a pty, send a prompt, and assert: (a) the rendered frame contains **no** log lines
(flood), (b) the assistant response renders (TUI not broken), (c) **a trace file is written** (the
exact thing the TUI-tracing regression broke). This one test would have caught the two worst misses.
Needs a pty/tmux harness and an in-process test model; make it a tagged/local + nightly job if it's
too heavy/flaky for every-PR CI. (See E2E-TUI-TRACING-REGRESSION.md for the open tracing bug it
guards.)

### C. PRESENCE tests for every fork hook  — partially shipped
For each fork feature that wires into an upstream-owned file, a test that asserts the hook is present
AND functions — the inverse of the false-green absence test. Shipped: log quiet-by-default. Needed:
"worker wires the trace consumer", "/api bridge present in server", "branding wordmark present". These
convert "silently dropped on next merge" into a red test.

### D. Fork-feature inventory + post-merge verification gate  — to build
A registry of every fork customization (tracing, logging, branding, auth defaults, TUI plugins,
in-process server, skill list, /api bridge, …) each mapped to its guard test, run as a required step
after every upstream merge. The merge checklist becomes: "every guard green," not "diff looks right."

### E. Output-hygiene as a standing CI gate
Generalize A: a representative set of commands must have clean stderr by default. Cheap, no creds,
catches the whole "stray logging / accidental stdout" class on every PR.

## 4. The one-line lesson
The bugs that hurt users most are **emergent runtime behaviors of the integrated, shipped artifact** —
exactly what diff-review and isolated unit tests are blind to. Close the gap by testing the running
binary the way a user runs it, and by guarding the *presence* of fork features, not just the *absence*
of old code.
