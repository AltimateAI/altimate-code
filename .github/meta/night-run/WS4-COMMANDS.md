# WS4 Command Verification

87 commands, 78 OK, 9 BROKEN.

Built binary: `/Users/anandgupta/codebase/altimate-code/.claude/worktrees/get_latest_upstream/packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate`
Generated: `2026-06-25T10:27:21.478Z`

Scope: command definitions under `packages/opencode/src/cli/cmd/`, plus yargs built-in `completion` because it appears in top-level help. Each `--help` was run from a fresh temp directory. Safe read-only smokes were also run from fresh temp directories; mutating, authenticating, server, browser-opening, upgrade, delete, and blocking commands were help-only. The required `run "print exactly OK" --model azure/gpt-4o-mini --yolo` smoke exited 0 and printed `OK`.

Command-file coverage note: helper/runtime files under `cmd/` were inspected but are not standalone CLI command rows: `check-helpers.ts`, `cmd.ts`, `github.handler.ts`, `github.shared.ts`, `prompt-display.ts`, `serve-upgrade-check.ts`, `skill-helpers.ts`, and `run/*` UI/runtime modules other than `run.ts`. `trajectory.ts` and `workspace-serve.ts` define commands and are included below; both are unreachable in this built binary.

| command | --help ec | smoke ec | status (OK/BROKEN) | notes |
|---|---:|---:|---|---|
| completion | 1 | 0 | BROKEN | BROKEN: \`completion --help\` exited 1 and printed root help instead of command-specific help. Smoke OK: \`#compdef altimate-code / ###-begin-altimate-code-completions-### / #\` help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| attach <url> | 0 | skip | BROKEN | BROKEN: help contains upstream branding/env leaks: \`OPENCODE_SERVER_PASSWORD\`, \`OPENCODE_SERVER_USERNAME\`, and default username \`opencode\`. help first lines: \`altimate-code attach <url> / attach to a running altimate-code server / Positionals:\` |
| run [message..] | 0 | 0 | BROKEN | BROKEN: help contains upstream env leak \`OPENCODE_SERVER_PASSWORD\`. Required run smoke exited 0 and output contained \`OK\`. help first lines: \`altimate-code run [message..] / run altimate with a message / Positionals:\` |
| skill list | 0 | 1 | BROKEN | BROKEN: read-only smoke exited 1 with exact error \`Error: Unexpected error\` / \`InstanceRef not provided\`. help first lines: \`altimate-code skill list / list all available skills with their paired tools / Options:\` |
| workspace-serve | 0 | skip | BROKEN | BROKEN: \`workspace-serve --help\` exited 0 but printed root help; \`WorkspaceServeCommand\` is conditional on \`InstallationLocal\` and is absent from this built binary. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| trajectory | 0 | skip | BROKEN | BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| trajectory list | 0 | skip | BROKEN | BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| trajectory show <sessionID> | 0 | skip | BROKEN | BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| trajectory export <sessionID> | 0 | skip | BROKEN | BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` |
| (default tui) [project] | 0 | skip | OK | source: \`tui.ts\` help: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\` smoke skipped: would start TUI/block |
| acp | 0 | skip | OK | source: \`acp.ts\` help: \`altimate-code acp / start ACP (Agent Client Protocol) server / Options:\` smoke skipped: would start ACP server/block |
| mcp | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp / manage MCP (Model Context Protocol) servers / Commands:\` smoke skipped: parent command requires subcommand |
| mcp list | 0 | 0 | OK | source: \`mcp.ts\` help: \`altimate-code mcp list / list MCP servers and their status / Options:\` smoke: read-only list; first lines \`┌  MCP Servers / │ / ▲  No MCP servers configured\` |
| mcp auth [name] | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp auth [name] / authenticate with an OAuth-enabled MCP server / Commands:\` smoke skipped: would start OAuth/auth flow |
| mcp auth list | 0 | 0 | OK | source: \`mcp.ts\` help: \`altimate-code mcp auth list / list OAuth-capable MCP servers and their auth status / Positionals:\` smoke: read-only OAuth status list; first lines \`┌  MCP OAuth Status / │ / ▲  No OAuth-capable MCP servers configured\` |
| mcp logout [name] | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp logout [name] / remove OAuth credentials for an MCP server / Positionals:\` smoke skipped: mutates stored OAuth credentials |
| mcp add | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp add / add an MCP server / Options:\` smoke skipped: mutates config |
| mcp remove <name> | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp remove <name> / remove an MCP server / Positionals:\` smoke skipped: mutates config |
| mcp debug <name> | 0 | skip | OK | source: \`mcp.ts\` help: \`altimate-code mcp debug <name> / debug OAuth connection for an MCP server / Positionals:\` smoke skipped: requires configured remote and may make network request |
| generate | 0 | 0 | OK | source: \`generate.ts\` help: \`altimate-code generate / Options: /   -h, --help        show help                                            ...\` smoke: read-only OpenAPI generation to stdout; first lines \`{ /   "openapi": "3.1.1", /   "info": {\` |
| debug | 0 | skip | OK | source: \`debug/index.ts\` help: \`altimate-code debug / debugging and troubleshooting tools / Commands:\` smoke skipped: parent command requires subcommand |
| debug config | 0 | 0 | OK | source: \`debug/config.ts\` help: \`altimate-code debug config / show resolved configuration / Options:\` smoke: read-only resolved config; first lines \`{ /   "$schema": "https://altimate.ai/config.json", /   "provider": {\` |
| debug lsp | 0 | skip | OK | source: \`debug/lsp.ts\` help: \`altimate-code debug lsp / LSP debugging utilities / Commands:\` smoke skipped: parent command requires subcommand |
| debug lsp diagnostics <file> | 0 | skip | OK | source: \`debug/lsp.ts\` help: \`altimate-code debug lsp diagnostics <file> / get diagnostics for a file / Positionals:\` smoke skipped: requires LSP/project setup |
| debug lsp symbols <query> | 0 | skip | OK | source: \`debug/lsp.ts\` help: \`altimate-code debug lsp symbols <query> / search workspace symbols / Positionals:\` smoke skipped: requires LSP/project setup |
| debug lsp document-symbols <uri> | 0 | skip | OK | source: \`debug/lsp.ts\` help: \`altimate-code debug lsp document-symbols <uri> / get symbols from a document / Positionals:\` smoke skipped: requires LSP/project setup |
| debug rg | 0 | skip | OK | source: \`debug/ripgrep.ts\` help: \`altimate-code debug rg / ripgrep debugging utilities / Commands:\` smoke skipped: parent command requires subcommand |
| debug rg files | 0 | 0 | OK | source: \`debug/ripgrep.ts\` help: \`altimate-code debug rg files / list files using ripgrep / Options:\` smoke: read-only rg file list in temp dir; first lines \`subdir/notes.txt / sample.sql / 2026-06-25T10:25:40.461Z [INFO] service=telemetry telemetry initialized mode=...\` |
| debug rg search <pattern> | 0 | 0 | OK | source: \`debug/ripgrep.ts\` help: \`altimate-code debug rg search <pattern> / search file contents using ripgrep / Positionals:\` smoke: read-only rg search in temp dir; first lines \`[ /   { /     "entry": {\` |
| debug file | 0 | skip | OK | source: \`debug/file.ts\` help: \`altimate-code debug file / file system debugging utilities / Commands:\` smoke skipped: parent command requires subcommand |
| debug file read <path> | 0 | 0 | OK | source: \`debug/file.ts\` help: \`altimate-code debug file read <path> / read file contents as JSON / Positionals:\` smoke: read-only temp fixture read; first lines \`{ /   "content": "c2VsZWN0IDEgYXMgc2FtcGxlOwo=", /   "encoding": "base64",\` |
| debug file list <path> | 0 | 0 | OK | source: \`debug/file.ts\` help: \`altimate-code debug file list <path> / list files in a directory / Positionals:\` smoke: read-only temp dir list; first lines \`[ /   { /     "path": "subdir/",\` |
| debug file search <query> | 0 | 0 | OK | source: \`debug/file.ts\` help: \`altimate-code debug file search <query> / search files by query / Positionals:\` smoke: read-only temp fixture search; first lines \`sample.sql / 2026-06-25T10:25:51.802Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-...\` |
| debug scrap | 0 | 0 | OK | source: \`debug/scrap.ts\` help: \`altimate-code debug scrap / list all known projects / Options:\` smoke: read-only known-project list; first lines \`[ /   { /     "id": "global",\` |
| debug skill | 0 | 0 | OK | source: \`debug/skill.ts\` help: \`altimate-code debug skill / list all available skills / Options:\` smoke: read-only skill dump; first lines \`[ /   { /     "name": "customize-opencode",\` |
| debug snapshot | 0 | skip | OK | source: \`debug/snapshot.ts\` help: \`altimate-code debug snapshot / snapshot debugging utilities / Commands:\` smoke skipped: parent command requires subcommand |
| debug snapshot track | 0 | skip | OK | source: \`debug/snapshot.ts\` help: \`altimate-code debug snapshot track / track current snapshot state / Options:\` smoke skipped: may create/track snapshot state |
| debug snapshot patch <hash> | 0 | skip | OK | source: \`debug/snapshot.ts\` help: \`altimate-code debug snapshot patch <hash> / show patch for a snapshot hash / Positionals:\` smoke skipped: requires existing snapshot hash |
| debug snapshot diff <hash> | 0 | skip | OK | source: \`debug/snapshot.ts\` help: \`altimate-code debug snapshot diff <hash> / show diff for a snapshot hash / Positionals:\` smoke skipped: requires existing snapshot hash |
| debug startup | 0 | 0 | OK | source: \`debug/startup.ts\` help: \`altimate-code debug startup / print startup timing / Options:\` smoke: read-only startup timing; first lines \`1163.773959 / 2026-06-25T10:26:03.662Z [INFO] service=telemetry telemetry initialized mode=appinsights\` |
| debug agent <name> | 0 | skip | OK | source: \`debug/agent.ts\` help: \`altimate-code debug agent <name> / show agent configuration details / Positionals:\` smoke skipped: requires agent name/tool setup |
| debug v2 | 0 | 0 | OK | source: \`debug/v2.ts\` help: \`altimate-code debug v2 / debug v2 catalog and built-in plugins / Options:\` smoke: read-only provider/catalog dump; first lines \`{ /   "providers": [ /     {\` |
| debug info | 0 | 0 | OK | source: \`debug/index.ts\` help: \`altimate-code debug info / show debug information / Options:\` smoke: read-only debug info; first lines \`altimate-code version: 0.0.0-upstream/merge-v1.17.9-202606251017 / os: Darwin 24.6.0 arm64 / terminal: iTerm....\` |
| debug paths | 0 | 0 | OK | source: \`debug/index.ts\` help: \`altimate-code debug paths / show global paths (data, config, cache, state) / Options:\` smoke: read-only global paths; first lines \`home       /Users/anandgupta / data       /Users/anandgupta/.local/share/opencode / bin        /Users/anandgu...\` |
| debug wait | 0 | skip | OK | source: \`debug/index.ts\` help: \`altimate-code debug wait / wait indefinitely (for debugging) / Options:\` smoke skipped: blocks indefinitely |
| console | 0 | skip | OK | source: \`account.ts\` help: \`altimate-code console / Commands: /   altimate-code console login [url]     log in to console\` smoke skipped: parent command requires subcommand |
| console login [url] | 0 | skip | OK | source: \`account.ts\` help: \`altimate-code console login [url] / log in to console / Positionals:\` smoke skipped: authenticates/opens browser |
| console logout [email] | 0 | skip | OK | source: \`account.ts\` help: \`altimate-code console logout [email] / log out from console / Positionals:\` smoke skipped: mutates account credentials |
| console switch | 0 | skip | OK | source: \`account.ts\` help: \`altimate-code console switch / switch active org / Options:\` smoke skipped: mutates active org |
| console orgs | 0 | 0 | OK | source: \`account.ts\` help: \`altimate-code console orgs / list orgs / Options:\` smoke: read-only org list; first lines \`2026-06-25T10:26:20.051Z [INFO] service=telemetry telemetry initialized mode=appinsights / No accounts found\` |
| console open | 0 | skip | OK | source: \`account.ts\` help: \`altimate-code console open / open active console account / Options:\` smoke skipped: opens browser |
| providers | 0 | skip | OK | source: \`providers.ts\` help: \`altimate-code providers / manage AI providers and credentials / Commands:\` smoke skipped: parent command requires subcommand; alias auth |
| providers list | 0 | 0 | OK | source: \`providers.ts\` help: \`altimate-code providers list / list providers and credentials / Options:\` smoke: read-only provider list; first lines \`┌  Credentials ~/.local/share/opencode/auth.json / │ / └  0 credentials\` |
| providers login [url] | 0 | skip | OK | source: \`providers.ts\` help: \`altimate-code providers login [url] / log in to a provider / Positionals:\` smoke skipped: authenticates/opens browser; alias auth login |
| providers logout [provider] | 0 | skip | OK | source: \`providers.ts\` help: \`altimate-code providers logout [provider] / log out from a configured provider / Positionals:\` smoke skipped: mutates provider credentials |
| agent | 0 | skip | OK | source: \`agent.ts\` help: \`altimate-code agent / manage agents / Commands:\` smoke skipped: parent command requires subcommand |
| agent create | 0 | skip | OK | source: \`agent.ts\` help: \`altimate-code agent create / create a new agent / Options:\` smoke skipped: generates/writes agent file |
| agent list | 0 | 0 | OK | source: \`agent.ts\` help: \`altimate-code agent list / list all available agents / Options:\` smoke: read-only agent list; first lines \`analyst (primary) /   [ /   {\` |
| upgrade [target] | 0 | skip | OK | source: \`upgrade.ts\` help: \`altimate-code upgrade [target] / upgrade altimate to the latest or a specific version / Positionals:\` smoke skipped: upgrade command skipped by prompt |
| uninstall | 0 | skip | OK | source: \`uninstall.ts\` help: \`altimate-code uninstall / uninstall altimate-code and remove all related files / Options:\` smoke skipped: dangerous global removal command skipped |
| serve | 0 | skip | OK | source: \`serve.ts\` help: \`altimate-code serve / starts a headless altimate-code server / Options:\` smoke skipped: starts headless server/block |
| web | 0 | skip | OK | source: \`web.ts\` help: \`altimate-code web / start altimate-code server and open web interface / Options:\` smoke skipped: starts server and opens browser/block |
| models [provider] | 0 | 0 | OK | source: \`models.ts\` help: \`altimate-code models [provider] / list all available models / Positionals:\` smoke: read-only model list; first lines \`opencode/big-pickle / opencode/deepseek-v4-flash-free / opencode/mimo-v2.5-free\` |
| stats | 0 | 0 | OK | source: \`stats.ts\` help: \`altimate-code stats / show token usage and cost statistics / Options:\` smoke: read-only usage stats; first lines \`┌────────────────────────────────────────────────────────┐ / │                       OVERVIEW                ...\` |
| export [sessionID] | 0 | skip | OK | source: \`export.ts\` help: \`altimate-code export [sessionID] / export session data as JSON / Positionals:\` smoke skipped: no-arg path may prompt for latest session |
| import <file> | 0 | skip | OK | source: \`import.ts\` help: \`altimate-code import <file> / import session data from JSON file or URL / Positionals:\` smoke skipped: imports/writes session data |
| github | 0 | skip | OK | source: \`github.ts\` help: \`altimate-code github / manage GitHub agent / Commands:\` smoke skipped: parent command requires subcommand |
| github install | 0 | skip | OK | source: \`github.ts\` help: \`altimate-code github install / install the GitHub agent / Options:\` smoke skipped: GitHub action/global install skipped by prompt |
| github run | 0 | skip | OK | source: \`github.ts\` help: \`altimate-code github run / run the GitHub agent / Options:\` smoke skipped: GitHub action skipped by prompt |
| gitlab | 0 | skip | OK | source: \`gitlab.ts\` help: \`altimate-code gitlab / manage GitLab MR reviews / Commands:\` smoke skipped: parent command requires subcommand |
| gitlab review <mr-url> | 0 | skip | OK | source: \`gitlab.ts\` help: \`altimate-code gitlab review <mr-url> / review a GitLab merge request / Positionals:\` smoke skipped: GitLab/network action skipped |
| review | 0 | skip | OK | source: \`review.ts\` help: \`altimate-code review / review dbt/SQL changes and emit a signed verdict (APPROVE/COMMENT/REQUEST_CHANGES) / O...\` smoke skipped: requires repo diff and may call reviewer unless configured |
| pr <number> | 0 | skip | OK | source: \`pr.ts\` help: \`altimate-code pr <number> / fetch and checkout a GitHub PR branch, then run altimate-code / Positionals:\` smoke skipped: gh action/checks out branches skipped by prompt |
| session | 0 | skip | OK | source: \`session.ts\` help: \`altimate-code session / manage sessions / Commands:\` smoke skipped: parent command requires subcommand |
| session delete <sessionID> | 0 | skip | OK | source: \`session.ts\` help: \`altimate-code session delete <sessionID> / delete a session / Positionals:\` smoke skipped: deletes session data |
| session list | 0 | 0 | OK | source: \`session.ts\` help: \`altimate-code session list / list sessions / Options:\` smoke: read-only session list; first lines \`2026-06-25T10:26:56.819Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-06-25T10:26:5...\` |
| plugin <module> | 0 | skip | OK | source: \`plug.ts\` help: \`altimate-code plugin <module> / install plugin and update config / Positionals:\` smoke skipped: installs plugin/mutates config; alias plug |
| db [query] | 0 | skip | OK | source: \`db.ts\` help: \`altimate-code db / database tools / Commands:\` smoke skipped: no-arg opens sqlite shell |
| db path | 0 | 0 | OK | source: \`db.ts\` help: \`altimate-code db path / print the database path / Options:\` smoke: read-only db path; first lines \`/Users/anandgupta/.local/share/opencode/opencode-upstream-merge-v1.17.9.db / 2026-06-25T10:27:01.378Z [INFO] ...\` |
| trace [action] [id] | 0 | 0 | OK | source: \`trace.ts\` help: \`altimate-code trace [action] [id] / list and view session traces (recordings of agent sessions) / Positionals:\` smoke: read-only trace list; first lines \`2026-06-25T10:27:03.709Z [INFO] service=telemetry telemetry initialized mode=appinsights / DATE         WHEN ...\` |
| skill | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill / manage skills and user CLI tools / Commands:\` smoke skipped: parent command requires subcommand |
| skill create <name> | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill create <name> / scaffold a new skill with a paired CLI tool / Positionals:\` smoke skipped: scaffolds files |
| skill test <name> | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill test <name> / validate a skill and its paired CLI tool / Positionals:\` smoke skipped: executes skill/tool tests |
| skill show <name> | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill show <name> / display the full content of a skill / Positionals:\` smoke skipped: requires existing skill name |
| skill install <source> | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill install <source> / install a skill from GitHub or a local path / Positionals:\` smoke skipped: installs files/network |
| skill remove <name> | 0 | skip | OK | source: \`skill.ts\` help: \`altimate-code skill remove <name> / remove an installed skill and its paired CLI tool / Positionals:\` smoke skipped: removes files |
| check [files..] | 0 | 0 | OK | source: \`check.ts\` help: \`altimate-code check [files..] / run deterministic SQL checks (lint, validate, safety, policy, pii — no LLM re...\` smoke: read-only temp SQL lint; first lines \`{ /   "version": 1, /   "files_checked": 1,\` |

## Broken Detail

- **completion**: BROKEN: \`completion --help\` exited 1 and printed root help instead of command-specific help. Smoke OK: \`#compdef altimate-code / ###-begin-altimate-code-completions-### / #\` help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`
- **attach <url>**: BROKEN: help contains upstream branding/env leaks: \`OPENCODE_SERVER_PASSWORD\`, \`OPENCODE_SERVER_USERNAME\`, and default username \`opencode\`. help first lines: \`altimate-code attach <url> / attach to a running altimate-code server / Positionals:\`
- **run [message..]**: BROKEN: help contains upstream env leak \`OPENCODE_SERVER_PASSWORD\`. Required run smoke exited 0 and output contained \`OK\`. help first lines: \`altimate-code run [message..] / run altimate with a message / Positionals:\`
- **skill list**: BROKEN: read-only smoke exited 1 with exact error \`Error: Unexpected error\` / \`InstanceRef not provided\`. help first lines: \`altimate-code skill list / list all available skills with their paired tools / Options:\`
- **workspace-serve**: BROKEN: \`workspace-serve --help\` exited 0 but printed root help; \`WorkspaceServeCommand\` is conditional on \`InstallationLocal\` and is absent from this built binary. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`
- **trajectory**: BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`
- **trajectory list**: BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`
- **trajectory show <sessionID>**: BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`
- **trajectory export <sessionID>**: BROKEN: \`trajectory\` command file exists, but the built binary prints root help for this path; \`TrajectoryCommand\` is not registered in \`packages/opencode/src/index.ts\`. help first lines: \`▄▀█ █   ▀█▀ █ █▀▄▀█ ▄▀█ ▀█▀ █▀▀ █▀▀ █▀█ █▀▄ █▀▀ / █▀█ █▄▄  █  █ █ ▀ █ █▀█  █  ██▄ █▄▄ █▄█ █▄▀ ██▄ / Commands:\`

## Read-Only Smokes Run

- `completion`: args `completion`, ec 0, first lines `#compdef altimate-code / ###-begin-altimate-code-completions-### / #`
- `mcp list`: args `mcp list`, ec 0, first lines `┌  MCP Servers / │ / ▲  No MCP servers configured`
- `mcp auth list`: args `mcp auth list`, ec 0, first lines `┌  MCP OAuth Status / │ / ▲  No OAuth-capable MCP servers configured`
- `run [message..]`: args `run print exactly OK --model azure/gpt-4o-mini --yolo`, ec 0, first lines `OK / 2026-06-25T10:25:21.666Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-06-25T10:25:21.720Z [INFO] service=mcp...`
- `generate`: args `generate`, ec 0, first lines `{ /   "openapi": "3.1.1", /   "info": {`
- `debug config`: args `debug config`, ec 0, first lines `{ /   "$schema": "https://altimate.ai/config.json", /   "provider": {`
- `debug rg files`: args `debug rg files --limit 5`, ec 0, first lines `subdir/notes.txt / sample.sql / 2026-06-25T10:25:40.461Z [INFO] service=telemetry telemetry initialized mode=appinsights`
- `debug rg search <pattern>`: args `debug rg search select --limit 5`, ec 0, first lines `[ /   { /     "entry": {`
- `debug file read <path>`: args `debug file read sample.sql`, ec 0, first lines `{ /   "content": "c2VsZWN0IDEgYXMgc2FtcGxlOwo=", /   "encoding": "base64",`
- `debug file list <path>`: args `debug file list .`, ec 0, first lines `[ /   { /     "path": "subdir/",`
- `debug file search <query>`: args `debug file search sample`, ec 0, first lines `sample.sql / 2026-06-25T10:25:51.802Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-06-25T10:25:51.846Z [INFO] ser...`
- `debug scrap`: args `debug scrap`, ec 0, first lines `[ /   { /     "id": "global",`
- `debug skill`: args `debug skill`, ec 0, first lines `[ /   { /     "name": "customize-opencode",`
- `debug startup`: args `debug startup`, ec 0, first lines `1163.773959 / 2026-06-25T10:26:03.662Z [INFO] service=telemetry telemetry initialized mode=appinsights`
- `debug v2`: args `debug v2`, ec 0, first lines `{ /   "providers": [ /     {`
- `debug info`: args `debug info`, ec 0, first lines `altimate-code version: 0.0.0-upstream/merge-v1.17.9-202606251017 / os: Darwin 24.6.0 arm64 / terminal: iTerm.app 3.6.6 / dumb`
- `debug paths`: args `debug paths`, ec 0, first lines `home       /Users/anandgupta / data       /Users/anandgupta/.local/share/opencode / bin        /Users/anandgupta/.cache/opencode/bin`
- `console orgs`: args `console orgs`, ec 0, first lines `2026-06-25T10:26:20.051Z [INFO] service=telemetry telemetry initialized mode=appinsights / No accounts found`
- `providers list`: args `providers list`, ec 0, first lines `┌  Credentials ~/.local/share/opencode/auth.json / │ / └  0 credentials`
- `agent list`: args `agent list`, ec 0, first lines `analyst (primary) /   [ /   {`
- `models [provider]`: args `models`, ec 0, first lines `opencode/big-pickle / opencode/deepseek-v4-flash-free / opencode/mimo-v2.5-free`
- `stats`: args `stats`, ec 0, first lines `┌────────────────────────────────────────────────────────┐ / │                       OVERVIEW                         │ / ├────────────────...`
- `session list`: args `session list --max-count 1 --format json`, ec 0, first lines `2026-06-25T10:26:56.819Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-06-25T10:26:56.868Z [INFO] service=mcp.disc...`
- `db path`: args `db path`, ec 0, first lines `/Users/anandgupta/.local/share/opencode/opencode-upstream-merge-v1.17.9.db / 2026-06-25T10:27:01.378Z [INFO] service=telemetry telemetry in...`
- `trace [action] [id]`: args `trace list --limit 1`, ec 0, first lines `2026-06-25T10:27:03.709Z [INFO] service=telemetry telemetry initialized mode=appinsights / DATE         WHEN      STATUS    DURATION  TOKEN...`
- `skill list`: args `skill list --json`, ec 1, first lines `2026-06-25T10:27:07.185Z [INFO] service=telemetry telemetry initialized mode=appinsights / 2026-06-25T10:27:07.228Z [INFO] service=mcp.disc...`
- `check [files..]`: args `check sample.sql --checks lint --format json`, ec 0, first lines `{ /   "version": 1, /   "files_checked": 1,`
