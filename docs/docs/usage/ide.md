---
title: "IDE Integration — Altimate Code in VS Code"
description: "Use Altimate Code inside VS Code via the Datamates extension. Requires the altimate-code CLI to be installed."
---

# IDE Integration

altimate-code integrates with your IDE via the [Datamates extension](https://marketplace.visualstudio.com/items?itemName=altimateai.vscode-altimate-mcp-server) — listed as **Datamates** in the Marketplace, its in-editor commands and docs are branded **Altimate MCP** — giving you AI-powered chat with 100+ data engineering tools directly in your editor.

---

## Prerequisites

Install the altimate-code CLI globally:

```bash
npm install -g altimate-code
```

The Datamates extension requires this to be installed for the chat and tools to function.

## Install the Extension

Install the Datamates extension for your IDE:

- **VS Code** — [Microsoft Marketplace](https://marketplace.visualstudio.com/items?itemName=altimateai.vscode-altimate-mcp-server)
- **Cursor / other VS Code-compatible editors** — [Open VSX Registry](https://open-vsx.org/extension/altimateai/vscode-altimate-mcp-server)
- **Windsurf** — Install via the built-in extension marketplace (search "Datamates")

## Open Altimate Code Chat

After installing the extension:

1. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux) to open the command palette
2. Type `Altimate MCP`
3. Select **Altimate MCP: Open Altimate Code Chat**

This opens the Altimate Code chat panel where you can interact with altimate agents and use all 100+ data engineering tools.

## Features

- **Inline chat** with altimate agents — ask questions, run tools, and get results directly in your editor
- **File context awareness** — the agent sees your open files and project structure
- **Tool call results inline** — SQL analysis, lineage, dbt operations, and more displayed in the chat
- **Agent mode switching** — switch between Builder (full read/write), Analyst (read-only), and Plan (minimal access) modes from the command palette
- **100+ data engineering tools** — SQL validation, query optimization, column lineage, dbt model generation, FinOps analysis, schema exploration, and more
- **Session tracing** — every chat session is recorded as a trace file (the IDE panel runs `altimate-code serve` under the hood, which now writes traces just like the terminal). Inspect them with `altimate-code trace list` / `altimate-code trace view <id>`. See [Traces](../configure/trace.md).

## Configuration

The extension uses your existing `altimate-code.json` config. No additional IDE-specific configuration is required. Warehouse connections, LLM providers, permissions, and agent settings all carry over.

### Extension settings

The extension contributes these VS Code settings (Settings → search "altimate"):

| Setting | Default | Description |
|---|---|---|
| `altimate.altimateCodeRequireConsent` | `false` | Ask before downloading and installing the altimate-code CLI. By default the extension installs the CLI automatically the first time chat is opened. When enabled, chat shows an install prompt instead — nothing is downloaded until you confirm, and declining shows manual install instructions. |
| `altimate.codeAutoUpdate` | `true` | Keep the CLI up to date automatically in the background. Checked at most once a day, and only runs when the CLI is already installed. |

The extension installs the CLI natively: the release archive is fetched over HTTPS from [GitHub releases](https://github.com/AltimateAI/altimate-code/releases), verified against the release's `checksums.txt` (SHA-256), and placed in `~/.altimate/bin` — no shell scripts are executed and nothing outside your home directory is modified. Environments that prefer full control can enable `altimate.altimateCodeRequireConsent` via managed settings, or pre-install the CLI themselves (the extension uses any `altimate` found on `PATH` or in `~/.altimate/bin`).

## LLM Access

You need an LLM to power the chat. Two options:

- **BYOK (Bring Your Own Key)** — Free and unlimited. Configure any of the [35+ supported providers](../configure/providers.md) (Anthropic, OpenAI, AWS Bedrock, Azure OpenAI, etc.)
- **[Altimate LLM Gateway](https://help.altimate.ai/datamates/user-guide/components/llm-gateway/)** — Managed LLM access with dynamic model routing. 10M tokens free to get started — no API keys to manage

## Full Altimate MCP Documentation

The Datamates extension offers additional capabilities beyond Altimate Code Chat, including MCP server integrations, Knowledge Hub, Memory Hub, and Guardrails. See the [Altimate MCP documentation](https://help.altimate.ai/datamates/) for full setup guides, integration configuration, and feature details.
