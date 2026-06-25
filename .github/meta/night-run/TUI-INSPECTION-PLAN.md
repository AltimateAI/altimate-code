# Overnight TUI Inspection Mandate (user: inspect everything, nothing breaks, all commands+traces, all upstream TUI copied)

## Tooling (validated)
- tmux 3.6a: drive+capture the TUI. Pattern: `tmux new-session -d -s X -x 220 -y 50 "cd <tmp> && BIN --model azure/gpt-5.5"`;
  `sleep`; `tmux send-keys -t X "..." Enter` / keystrokes; `tmux capture-pane -t X -p` to SEE rendered frame; `tmux kill-session -t X`.
- Models for testing: azure/gpt-5.5 (VERIFIED works + --yolo), "Big Pickle" (bigpickle, shown in TUI), openrouter. Use --yolo for non-interactive perms.
- BIN: packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate (REBUILD after branding+route fixes; build:local needs bun>=1.3.14 -> temporarily relax gate in packages/script/src/index.ts then REVERT via git).

## CONFIRMED BUGS (from tmux capture, matching user screenshot)
- TUI flooded with /api/provider + /api/model -> "Unable to connect" (server.ts:655 catch-all proxies to app.altimate.ai). v2 client uses /api prefix, server mounts at root. SAME root as httpapi-sdk test fail. -> WS1 codex fixing.
- opencode ASCII logo + "OpenCode Zen" branding (stale binary; logo.ts rebranded in source by CI-fix; rebuild needed). "OpenCode Zen/Go" = models-snapshot catalog data.

## Workstreams
- WS1 (codex /tmp/ws1_route_fix.log): fix /api routing flood. RUNNING.
- WS2 (codex /tmp/ws2_tui_diff.log): verify all upstream TUI changes copied -> TUI-UPSTREAM-DIFF.md. RUNNING.
- CI-fix (codex /tmp/fix_ci.log): branding 198->0 + require-markers config. RUNNING.
- WS3 (me, tmux): visually inspect EVERY TUI surface after clean rebuild — splash/logo (altimate not opencode), model picker, session view, sidebar/footer, dialogs (ctrl+p commands, mcp, status, workspace, theme, help), agents (tab), prompt editor, scrollback. Capture each frame; verify renders + no crash + no opencode branding + no error flood.
- WS4 (codex): test ALL commands — slash/ctrl+p commands + `run --command <name>` modes + each builtin command. Verify each executes.
- WS5 (codex): verify TRACES work — tracing enabled, trace events recorded, trace viewer renders (the fork's tracing feature).

## Loop: collect codex -> verify(typecheck0+production+area-tests) -> commit+push (update PR #964) -> rebuild clean binary -> WS3/4/5 -> iterate until EVERY functionality evaluated. Use heartbeat; don't stop until done.
