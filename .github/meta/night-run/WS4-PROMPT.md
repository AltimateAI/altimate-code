# WS4 — Verify EVERY CLI command works (post upstream-merge v1.17.9)

You are an autonomous verifier for **altimate-code** (an OpenCode fork) after a large upstream merge (v1.4.0 → v1.17.9). Be thorough and fully autonomous. Do NOT ask questions.

- Working dir: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream`
- Built binary (USE THIS, do not rebuild): `packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate`
- Model for any run that needs one: `azure/gpt-4o-mini` (key already in `~/.config/altimate-code/config.json`)

## Steps
1. Enumerate ALL top-level commands and subcommands by reading `packages/opencode/src/cli/cmd/` (every `.ts` file defines a command/subcommand). Build the complete command list.
2. For EACH command + subcommand, run `<binary> <command...> --help` in a fresh temp dir. Capture exit code + first ~3 lines. BROKEN = `--help` exits non-zero, errors, or prints a stack trace / "opencode" branding leak.
3. For safe read-only commands also run them with no args in a temp dir and record exit code/output: `models`, `providers list`, `agent list`, `session list`, `stats`, `db path`, `mcp list`, `config` (and any other obviously read-only ones).
4. For `run`: do ONE real non-interactive smoke — `<binary> run "print exactly OK" --model azure/gpt-4o-mini --yolo` in a temp dir; record exit code + whether output contains OK.
5. DO NOT run anything that mutates global state, pushes, upgrades, authenticates, or blocks: skip `auth login`, `upgrade`, `github`/`gh` actions, and do NOT leave `serve`/`tui` running (for those just confirm `--help`).

## Output
Write `.github/meta/night-run/WS4-COMMANDS.md`:
- A table: `command | --help ec | smoke ec | status (OK/BROKEN) | notes`
- BROKEN commands listed FIRST with the exact error.
- A one-line summary: `N commands, X OK, Y BROKEN`.
Cover EVERY command file — do not sample.
