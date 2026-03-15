# Custom Tools

Create custom tools using TypeScript and the altimate plugin system.

## Quick Start

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
