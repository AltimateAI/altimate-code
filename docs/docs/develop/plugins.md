# Plugins

Plugins extend altimate with custom tools, hooks, and behaviors.

## Creating a Plugin

```bash
mkdir my-plugin && cd my-plugin
npm init -y
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
      name: "my_tool",
      description: "A custom tool",
      parameters: z.object({
        query: z.string(),
      }),
      async execute({ query }) {
        return { result: query.toUpperCase() }
      },
    },
  ],
  hooks: {
    onSessionStart(session) {
      console.log("Session started:", session.id)
    },
    onToolCall(call) {
      console.log("Tool called:", call.name)
    },
  },
})
```

## Registering Plugins

```json
{
  "plugin": [
    "@altimateai/altimate-code-plugin-example",
    "./path/to/local-plugin",
    "npm-published-plugin"
  ]
}
```

## Plugin Hooks

Plugins can listen to lifecycle events:

| Hook | Description |
|------|------------|
| `onSessionStart` | Session created |
| `onSessionEnd` | Session ended |
| `onMessage` | User message received |
| `onResponse` | AI response generated |
| `onToolCall` | Before tool execution |
| `onToolResult` | After tool execution |
| `onFileEdit` | File edited |
| `onFileWrite` | File written |
| `onError` | Error occurred |

## Plugin API

```typescript
import { definePlugin, defineTool } from "@altimateai/altimate-code-plugin"
```

| Export | Description |
|--------|------------|
| `definePlugin` | Define a plugin with tools and hooks |
| `defineTool` | Define a standalone tool |

## Disabling Default Plugins

```bash
export ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS=true
```
