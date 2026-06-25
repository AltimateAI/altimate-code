# E2E finding: interactive TUI sessions no longer write trace files (merge regression)

Found 2026-06-25 during a local-build E2E pass on `upstream/merge-v1.17.9` (PR #964). NOT fixed in
the PR — documented here as a follow-up. My attempted fixes were reverted (see "Why not fixed yet").

## Symptom
Running the compiled binary's TUI (`altimate-code` with no subcommand), driving a session to
completion, and quitting writes **no** trace file under `~/.local/share/altimate-code/traces/`.
`altimate-code run` and `altimate-code serve` DO write traces (verified in the same E2E).

## Root cause
The pre-merge worker `packages/opencode/src/cli/cmd/tui/worker.ts` carried an `altimate_change`
`TraceConsumer` integration: `new TraceConsumer()`, `loadConfig()`, `handleEvent()` fed from
`sdk.event.subscribe`, and `flush()` on shutdown. The v1.17.0 extraction rewrote the worker into
`packages/opencode/src/cli/tui/worker.ts` and **dropped that integration entirely** — the new worker
only forwards events to the TUI via `GlobalBus.on("event")` and runs `Server.listen`; nothing feeds a
trace consumer. `run` (in-process `Tracer.setActive`) and `serve` (`subscribeTraceConsumer`) kept
their own tracing, so only the interactive TUI regressed.

## Why CI didn't catch it
`test/cli/tui/worker-trace-clearing.test.ts` only asserts the OLD manual logic is *absent*
(`!setWorkspace`, `!startEventStream`, `!sessionTraces.clear`) — it never asserts the NEW shared
consumer is *present*. So the worker passing the test while having zero tracing is a false green.
A follow-up should add a presence assertion (worker wires the shared TraceConsumer).

## Why not fixed yet (two approaches tried, both blocked by a deeper layer)
1. **Re-home `subscribeTraceConsumer({ directory: process.cwd() })` in the worker** (same helper
   serve uses). Result: the consumer initialized but **received no session events**. Its SDK
   `sdk.event.subscribe` against `Server.Default()/event` did not see the worker's in-process
   (`Server.Default().fetch`) session events — likely a multi-instance Bus-delivery gap (the
   per-request `/event` subscription's instance/bus differs from the session's). serve works because
   its sessions arrive over the TCP listener in the same context the subscription reads.
2. **Feed the worker's existing `GlobalBus.on("event")` stream into a `TraceConsumer` directly**
   (mirrors the pre-merge worker). Result (confirmed with diagnostics): all 13 session events were
   fed (`message.updated`/`message.part.updated`/`session.idle`) and `flush()` ran on shutdown — but
   **no trace was built**, because `TraceConsumer.handleEvent` expects the SDK-normalized event shape
   (`properties.info`, etc.) that `/event` produces, NOT the raw `GlobalBus` payload shape. So events
   arrive but the consumer can't parse them.

Both paths need server-internals work (event normalization + the in-process bus-delivery path), so
the change was reverted rather than shipped half-working.

## Also observed (shared, non-fatal)
`TraceConsumer.loadConfig()` calls `Config.get()` (a facade needing an Instance on the canonical ALS).
At consumer init neither serve nor the TUI worker has an instance provided, so both log
`[tracing] failed to load config, using default tracer error=InstanceRef not provided`. It's
non-fatal — serve still writes traces via the default `FileExporter` fallback — but the real tracing
config (custom dir / maxFiles / HTTP exporters) is NOT applied. A proper fix should run the
consumer's `loadConfig` inside an instance context (e.g. `Instance.restore` over
`InstanceRuntime.load({ directory })`, the same mechanism as the bootstrap root-fix).

## Recommended fix (for the follow-up)
- Decide the worker's event source: either (a) make an SDK `/event` subscription that actually
  receives the worker's in-process session events, or (b) normalize `GlobalBus` payloads to the
  consumer's expected shape before `handleEvent`.
- Wrap the consumer's `loadConfig` in an instance context so real tracing config applies (fixes the
  shared `InstanceRef not provided` warning in serve too).
- Ensure `flush()` runs on TUI quit — tui.ts already calls the worker `shutdown()` RPC (5s timeout)
  before `worker.terminate()`, so a `flush()` in `shutdown()` is sufficient once events are parsed.
- Add a regression test asserting the worker wires the shared trace consumer (close the false-green).

## What WAS verified working in this E2E (compiled binary, darwin-arm64)
- `--version` / `--help` (ALTIMATE branding, no opencode leaks in the command list)
- `skill list` (InstanceRef root fix) — lists 21 skills, no "InstanceRef not provided"
- `run` + tracing — real Vertex Anthropic call; well-formed trace written (status completed, spans,
  summary, narrative)
- `serve` + auth — `opencode:pw` → 200, `altimate:pw` → 401 (auth-username fix), no-auth/wrong-pw → 401
- `/config` (legacy Hono), `/api/provider` (httpApiBridge), `/doc` (openapi) → 200
- TUI full conversation — renders branding/sidebar/cost; correct answers (17+25=42, 100-58=42)
