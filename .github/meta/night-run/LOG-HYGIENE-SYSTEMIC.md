# Log hygiene: why it regresses on every merge, and the systemic fix

Date: 2026-06-25

## Symptom (recurring)
After an upstream merge, stray log lines flood / corrupt the interactive TUI:
- `service=... [INFO] ...` (our own logging)
- `{"level":"INFO","message":"Configuring logger with level: -1 ..."}` (snowflake-sdk Winston)
- `[upgrade] failed to fetch latest version ... 404` (branch-build version check)

It was "fixed" before, yet comes back after each merge.

## Root cause — two distinct classes
**Class A — fork suppression hooks get dropped by the overlay.** The bridge merge
re-overlays ~1850 upstream files. When a "keep the TUI clean" hook lives inside an
upstream-owned file (e.g. an `init()` call in an entrypoint), the overlay silently drops
it. No compile error, no failing test → it ships.

**Class B — a library writes to stdout/stderr in-process.** The TUI runs the server in a
Bun **Worker thread** (`cli/tui/worker.ts`), which shares the process's stdout/stderr fd
with the main thread that draws the TUI. RPC is over `postMessage`, so those streams carry
nothing functional — but ANY in-process write corrupts the render: snowflake-sdk, upstream
Effect `Logging`, our shim under `--print-logs`, or a dep a FUTURE merge adds. Suppressing
each offender one-by-one is whack-a-mole that regresses every merge.

## The systemic fix — defense in depth (4 layers)

1. **Make our own logging merge-proof (Class A).** `src/altimate/util/log.ts` reads
   `OPENCODE_PRINT_LOGS` **lazily at emit time**, quiet by default. There is no `init()`
   for a merge to drop — the env default is self-correcting. (Already in place.)

2. **Kill Class B at the one chokepoint.** `src/cli/tui/worker-console-guard.ts` redirects
   the worker's stdout/stderr to the log file (`<xdgData>/opencode/log/tui-worker-<pid>.log`)
   and is imported FIRST in `worker.ts`. Any in-process library write — present or
   future — goes to the file, never the terminal. One hook instead of N per-library
   suppressions. Runtime-verified: a write after import lands in the log file, not the
   terminal.

3. **Presence guards (catch Class A drops at unit speed).**
   `test/upstream/fork-feature-guards.test.ts` asserts each hook is still wired: log shim
   quiet-by-default, the worker console guard import + redirect, the fff project-scope, the
   TUI trace consumer. A merge that drops one turns the test red.

4. **Real-binary backstop (catch BOTH classes on every CI run).**
   `test/cli/smokes/output-hygiene.test.ts` spawns the actual entrypoint and asserts the
   terminal output contains none of: `service=`, `[INFO]`, JSON `{"level":"..."}`,
   `Configuring logger with level`, `[upgrade] failed to fetch latest version`,
   `InstanceRef not provided`. This converts "silently regresses and ships" into "the merge
   PR fails CI."

## Merge checklist (logging)
- [ ] `worker.ts` still imports `./worker-console-guard` FIRST.
- [ ] `log.ts` still reads `OPENCODE_PRINT_LOGS` lazily (no reintroduced always-on writer).
- [ ] `fork-feature-guards` + `output-hygiene` smokes green.
- [ ] Build the real binary and eyeball the TUI — no stray lines in the status area.

## Per-offender notes
- snowflake-sdk also re-raises its log level via "Easy Logging" during `connect()`; the
  driver re-applies `configure({logLevel:"OFF"})` after connect AND silences the configure
  call itself (`packages/drivers/src/snowflake.ts`). The worker guard is the safety net if a
  new driver/dep forgets to.
