# IDE Integration

altimate-code integrates with your IDE via the [Datamates extension](https://marketplace.visualstudio.com/items?itemName=altimateai.vscode-altimate-mcp-server), giving you AI-powered chat with 100+ data engineering tools directly in your editor.

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
2. Type `Datamates`
3. Select **Datamates: Open Altimate Code Chat**

This opens the Altimate Code chat panel where you can interact with altimate agents and use all 100+ data engineering tools.

## Features

- **Inline chat** with altimate agents — ask questions, run tools, and get results directly in your editor
- **File context awareness** — the agent sees your open files and project structure
- **Tool call results inline** — SQL analysis, lineage, dbt operations, and more displayed in the chat
- **Agent mode switching** — switch between Builder (full read/write), Analyst (read-only), and Plan (minimal access) modes from the command palette
- **100+ data engineering tools** — SQL validation, query optimization, column lineage, dbt model generation, FinOps analysis, schema exploration, and more

## Configuration

The extension uses your existing `altimate-code.json` config. No additional IDE-specific configuration is required. Warehouse connections, LLM providers, permissions, and agent settings all carry over.

## LLM Access

You need an LLM to power the chat. Two options:

- **BYOK (Bring Your Own Key)** — Free and unlimited. Configure any of the [35+ supported providers](../configure/providers.md) (Anthropic, OpenAI, AWS Bedrock, Azure OpenAI, etc.)
- **[Altimate LLM Gateway](https://datamates-docs.myaltimate.com/user-guide/components/llm-gateway/)** — Managed LLM access with dynamic model routing. 10M tokens free to get started — no API keys to manage

## Full Datamates Documentation

The Datamates extension offers additional capabilities beyond Altimate Code Chat, including MCP server integrations, Knowledge Hub, Memory Hub, and Guardrails. See the [Datamates documentation](https://datamates-docs.myaltimate.com/) for full setup guides, integration configuration, and feature details.
