# Real-Binary TUI Journeys

This suite drives the compiled `altimate-code` binary through `tmux` and asserts
what a tester sees in the terminal. It lives under `packages/opencode/test`
because it validates the packaged CLI/TUI behavior end-to-end; `packages/tui`
tests are a better fit for in-process component or renderer checks.

The suite is opt-in. It is skipped unless all conditions are true:

- `OPENCODE_TEST_CLI` points at a compiled binary.
- `tmux` is available on `PATH`.
- The runner can bind a local loopback HTTP server for the mock LLM and MCP
  auth fixtures.

## Run Locally

From `packages/opencode`:

```sh
bun run build:local
OPENCODE_TEST_CLI="$PWD/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate-code" \
  bun test test/tui-journeys --timeout 120000
```

From the repo root:

```sh
(
  cd packages/opencode
  OPENCODE_TEST_CLI="$PWD/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate-code" \
    bun test test/tui-journeys --timeout 120000
)
```

Each journey gets a fresh `HOME`, XDG directories, workspace, trace directory,
and `OPENCODE_CONFIG_CONTENT`. User config, history, credentials, and project
state are never read.

## Add A Journey

Use `withJourney("name", async (tui, ctx) => { ... })` from `harness.ts`.

- Script model output with `await tui.ctx.llm.text("...")` or
  `await tui.ctx.llm.tool("terminal", { ... })`.
- Drive the terminal with `tui.type("text")` and `tui.send("C-p")`.
- Assert visible state with `tui.snapshot()` or OSC/hyperlink state with
  `tui.snapshotAnsi()`.
- Prefer `await tui.waitFor(predicate, timeout)` over fixed sleeps.
- Keep the journey focused on one user-visible behavior.

On failure, the harness writes final pane captures, ANSI captures, stderr, and
mock LLM request bodies to `artifacts/` next to this README. Those files are
local debugging output and should not be committed.

## Flake Policy

Journeys should use generous waits, retry once at the Bun test level, and avoid
hard sleeps except for short UI stabilization after a keypress. Keep each test
near 30 seconds or less and the whole suite under 8 minutes.

If the compiled binary is genuinely broken, do not change product code from this
suite. Convert that journey to `test.todo` with a `FINDING(#issue): ...` comment
that states the observed behavior and report it with the run results.
