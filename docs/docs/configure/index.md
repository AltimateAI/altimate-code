# Configure

altimate is built from a small set of composable pieces. This section covers what they are and how to configure them.

## Architecture

```
┌─────────────────────────────────────────────┐
│                 Agent Modes                  │
│        (Builder · Analyst · Validator        │
│          Migrator · Documenter)              │
├─────────────────────────────────────────────┤
│              Skills & Commands               │
│   (high-level workflows you can invoke)      │
├─────────────────────────────────────────────┤
│                   Tools                      │
│  (99+ specialized tools for SQL, dbt,        │
│   lineage, cost, schema, warehouses)         │
├─────────────────────────────────────────────┤
│            Providers & Models                │
│   (Anthropic · OpenAI · Bedrock · Ollama     │
│    + 30 more LLM backends)                   │
└─────────────────────────────────────────────┘
```

**Agent Modes** define *how* altimate behaves — permissions, guardrails, and tool access. **Skills** are high-level workflows (e.g. `/data`, `/migrate`). **Tools** are the 99+ low-level capabilities that skills orchestrate. **Providers & Models** connect altimate to your LLM of choice.

## What's in this section

<div class="grid cards" markdown>

-   :material-robot-outline:{ .lg .middle } **Agent Modes**

    ---

    Five governed modes — Builder, Analyst, Validator, Migrator, Documenter — each with different permissions and tool access.

    [:octicons-arrow-right-24: Agent Modes](../data-engineering/agent-modes.md)

-   :material-lightning-bolt:{ .lg .middle } **Skills**

    ---

    High-level workflows you invoke with slash commands. Skills chain tools together to complete complex tasks.

    [:octicons-arrow-right-24: Skills](skills.md)

-   :material-wrench:{ .lg .middle } **Tools**

    ---

    99+ specialized tools for SQL analysis, schema inspection, lineage, cost prediction, dbt, and warehouse operations.

    [:octicons-arrow-right-24: Tools](../data-engineering/tools/index.md)

-   :material-cloud-outline:{ .lg .middle } **Providers & Models**

    ---

    Connect to 35+ LLM providers — Anthropic, OpenAI, Bedrock, Ollama, and more. Configure API keys and model selection.

    [:octicons-arrow-right-24: Providers](providers.md) · [:octicons-arrow-right-24: Models](models.md)

-   :material-cog:{ .lg .middle } **Agents & Tools**

    ---

    Fine-tune agent prompts, tool permissions, custom tools, and slash commands.

    [:octicons-arrow-right-24: Agents](agents.md) · [:octicons-arrow-right-24: Custom Tools](custom-tools.md)

-   :material-shield-check:{ .lg .middle } **Behavior**

    ---

    Rules, permissions, context management, and formatters that control how altimate operates.

    [:octicons-arrow-right-24: Rules](rules.md) · [:octicons-arrow-right-24: Permissions](permissions.md)

-   :material-palette:{ .lg .middle } **Appearance**

    ---

    Themes, keybinds, and visual customization for the TUI.

    [:octicons-arrow-right-24: Themes](themes.md) · [:octicons-arrow-right-24: Keybinds](keybinds.md)

-   :material-puzzle:{ .lg .middle } **Integrations**

    ---

    Connect to LSP servers, MCP servers, and ACP-compatible tools.

    [:octicons-arrow-right-24: Integrations](lsp.md)

</div>

## Config file

altimate uses JSON configuration files (`altimate-code.json`). For the full config file reference, see the [config file documentation](config.md).
