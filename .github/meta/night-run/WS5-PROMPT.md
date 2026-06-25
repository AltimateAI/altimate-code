# WS5 — Verify TRACING works end-to-end (post upstream-merge v1.17.9)

You are an autonomous verifier for **altimate-code** (an OpenCode fork) after a large upstream merge (v1.4.0 → v1.17.9). Be thorough and fully autonomous. Do NOT ask questions.

- Working dir: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`
- Built binary (USE THIS, do not rebuild): `packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate`
- Model: `azure/gpt-4o-mini` (key already in `~/.config/altimate-code/config.json`)

## Steps
1. Find the tracing implementation. Search `packages/opencode/src/altimate/` and `packages/opencode/src/` for: `tracer`, `trace`, `recap`, `Tracing`, trace-event emission, and where trace artifacts are written (files / sqlite / dir). Read the relevant files to understand the design.
2. Determine EXACTLY how tracing is enabled — env var (e.g. `ALTIMATE_TRACE`, `OPENCODE_TRACE`), config flag, or CLI flag. Quote the code that gates it.
3. Run a real agent task with tracing ENABLED using the binary, in a fresh temp dir, non-interactive:
   `<binary> run "write a haiku about databases to haiku.txt then read it back" --model azure/gpt-4o-mini --yolo`
   (prefix/add whatever enables tracing from step 2).
4. Confirm trace artifacts were produced: locate the output, verify events were recorded (count > 0, well-formed JSON/rows), and that they reference the run.
5. If there is a trace viewer/command (a `trace`/`recap` subcommand, or a served route/UI), confirm it lists/renders the trace.

## Output
Write `.github/meta/night-run/WS5-TRACES.md`:
- How tracing is enabled (with the gating code quoted + file:line).
- Exact command(s) run.
- Where artifacts landed + event counts (with evidence: paths, sample lines).
- Viewer/command status.
- **PASS/FAIL verdict** with evidence. If FAIL, the exact error + root cause.
