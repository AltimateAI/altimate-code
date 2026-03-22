# Custom Tools

There are two ways to extend altimate-code with custom tools:

1. **CLI tools** (recommended) — simple executables paired with skills
2. **Plugin tools** — TypeScript-based tools using the plugin API

## CLI Tools (Recommended)

The simplest way to add custom functionality. Drop any executable into `.opencode/tools/` and it's automatically available to the agent via bash.

### Quick Start

```bash
# Scaffold a skill + CLI tool pair
altimate-code skill create my-tool

# Or create manually:
mkdir -p .opencode/tools
cat > .opencode/tools/my-tool << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "Hello from my-tool!"
EOF
chmod +x .opencode/tools/my-tool
```

Tools in `.opencode/tools/` are automatically prepended to PATH when the agent runs bash commands. No configuration needed.

### Tool Locations

| Location | Scope | Auto-discovered |
|----------|-------|-----------------|
| `.opencode/tools/` | Project | Yes |
| `~/.config/altimate-code/tools/` | Global (all projects) | Yes |

### Pairing with Skills

Create a `SKILL.md` that teaches the agent when and how to use your tool:

```bash
altimate-code skill create my-tool --language python
```

This creates both `.opencode/skills/my-tool/SKILL.md` and `.opencode/tools/my-tool`. Edit both files to implement your tool.

### Validating

```bash
altimate-code skill test my-tool
```

This checks that the SKILL.md is valid and the paired tool is executable.

### Installing Community Skills

Install skills (with their paired tools) from GitHub:

```bash
# From a GitHub repo
altimate-code skill install anthropics/skills
altimate-code skill install dagster-io/skills

# From a GitHub web URL (pasted from browser)
altimate-code skill install https://github.com/owner/repo/tree/main/skills/my-skill

# Remove an installed skill
altimate-code skill remove my-skill
```

Or use the TUI: type `/skills`, then `ctrl+i` to install or `ctrl+a` → Remove to delete.

### Output Conventions

For best results with the AI agent:

- **Default output:** Human-readable text (the agent reads this well)
- **`--json` flag:** Structured JSON for scripting
- **Summary first:** "Found 12 matches:" or "3 issues detected:"
- **Errors to stderr**, results to stdout
- **Exit code 0** = success, **1** = error

## Plugin Tools (Advanced)

For more complex tools that need access to the altimate-code runtime, use the TypeScript plugin system.

### Quick Start

1. Create a tools directory:

```bash
mkdir -p .altimate-code/tools
```

2. Create a tool file:

```typescript
// .altimate-code/tools/my-tool.ts
import { defineTool } from "@altimateai/altimate-code-plugin/tool"
import { z } from "zod"

export default defineTool({
  name: "my_custom_tool",
  description: "Does something useful",
  parameters: z.object({
    input: z.string().describe("The input to process"),
  }),
  async execute({ input }) {
    // Your tool logic here
    return { result: `Processed: ${input}` }
  },
})
```

## Plugin Package

For more complex tools, create a plugin package:

```bash
npm init
npm install @altimateai/altimate-code-plugin zod
```

```typescript
// index.ts
import { definePlugin } from "@altimateai/altimate-code-plugin"
import { z } from "zod"

export default definePlugin({
  name: "my-plugin",
  tools: [
    {
      name: "analyze_costs",
      description: "Analyze warehouse costs",
      parameters: z.object({
        warehouse: z.string(),
        days: z.number().default(30),
      }),
      async execute({ warehouse, days }) {
        // Implementation
        return { costs: [] }
      },
    },
  ],
})
```

## Registering Plugins

Add plugins to your config:

```json
{
  "plugin": [
    "@altimateai/altimate-code-plugin-example",
    "./my-local-plugin"
  ]
}
```

## Plugin Hooks

Plugins can hook into 30+ lifecycle events:

- `onSessionStart` / `onSessionEnd`
- `onMessage` / `onResponse`
- `onToolCall` / `onToolResult`
- `onFileEdit` / `onFileWrite`
- `onError`
- And more...

## Disabling Default Plugins

```bash
export ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS=true
```
