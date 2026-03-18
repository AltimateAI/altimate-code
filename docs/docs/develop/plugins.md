# Plugins

Plugins extend altimate with custom tools, hooks, and behaviors. Use plugins to add domain-specific rules, integrate with internal APIs, log telemetry, enforce governance policies, or customize how the agent interacts with your data stack.

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

Add plugins to your `altimate-code.json` config file:

```json
{
  "plugin": [
    "@altimateai/altimate-code-plugin-example",
    "./path/to/local-plugin",
    "npm-published-plugin"
  ]
}
```

Plugins can be specified as:

- **npm package name**: installed from the registry (e.g., `"npm-published-plugin"`)
- **Relative path**: a local directory (e.g., `"./path/to/local-plugin"`)
- **Scoped package**: with an org prefix (e.g., `"@altimateai/altimate-code-plugin-example"`)

## Plugin Hooks

Plugins can listen to lifecycle events. Each hook receives a context object with data relevant to the event.

| Hook | When It Fires | Data Available |
|------|--------------|----------------|
| `onSessionStart` | A new session is created | `session.id`, `session.agent`, `session.metadata` |
| `onSessionEnd` | A session is closed or expires | `session.id`, `session.duration`, `session.messageCount` |
| `onMessage` | User sends a message to the agent | `message.content`, `message.sessionId`, `message.agent` |
| `onResponse` | Agent generates a response | `response.content`, `response.sessionId`, `response.toolCalls` |
| `onToolCall` | Before a tool is executed | `call.name`, `call.parameters`, `call.sessionId` (return `false` to cancel) |
| `onToolResult` | After a tool finishes executing | `result.toolName`, `result.output`, `result.duration`, `result.error` |
| `onFileEdit` | A file is modified via the agent | `edit.filePath`, `edit.oldContent`, `edit.newContent`, `edit.sessionId` |
| `onFileWrite` | A new file is created via the agent | `write.filePath`, `write.content`, `write.sessionId` |
| `onError` | An error occurs during processing | `error.message`, `error.code`, `error.stack`, `error.sessionId` |
| `onConfigChange` | Configuration is reloaded or modified | `config.previous`, `config.current`, `config.changedKeys` |

### Hook Execution Order

Hooks fire in this order during a typical interaction:

1. `onSessionStart` (once per session)
2. `onMessage` (each user message)
3. `onToolCall` (before each tool runs)
4. `onToolResult` (after each tool completes)
5. `onFileEdit` / `onFileWrite` (if the tool modifies files)
6. `onResponse` (when the agent produces a response)
7. `onError` (if something fails, at any point)
8. `onSessionEnd` (when the session closes)

## Example: SQL Anti-Pattern Plugin

This example creates a data-engineering-specific plugin that checks for `CROSS JOIN` without a `WHERE` clause in Snowflake SQL. This is a common anti-pattern that can cause massive result sets and runaway costs.

### Plugin File

```typescript
// plugins/sql-antipattern-cross-join/index.ts
import { definePlugin, defineTool } from "@altimateai/altimate-code-plugin"
import { z } from "zod"

/**
 * Detects CROSS JOIN usage without a WHERE clause in Snowflake SQL.
 * This anti-pattern can produce cartesian products and consume
 * excessive credits.
 */
const crossJoinChecker = defineTool({
  name: "check_cross_join_antipattern",
  description:
    "Checks SQL for CROSS JOIN without a WHERE clause, which can cause cartesian products in Snowflake",
  parameters: z.object({
    sql: z.string().describe("The SQL query to analyze"),
    severity: z
      .enum(["warning", "error"])
      .default("error")
      .describe("Severity level for detected anti-patterns"),
  }),
  async execute({ sql, severity }) {
    const findings: Array<{
      line: number
      message: string
      severity: string
      suggestion: string
    }> = []

    const lines = sql.split("\n")
    const upperSql = sql.toUpperCase()

    // Check for CROSS JOIN
    const crossJoinRegex = /\bCROSS\s+JOIN\b/gi
    let match: RegExpExecArray | null

    while ((match = crossJoinRegex.exec(sql)) !== null) {
      const lineNumber =
        sql.substring(0, match.index).split("\n").length

      // Check if there's a WHERE clause after this CROSS JOIN
      const afterJoin = upperSql.substring(match.index)
      const hasWhere = /\bWHERE\b/.test(afterJoin)
      const hasLimit = /\bLIMIT\b/.test(afterJoin)

      if (!hasWhere) {
        findings.push({
          line: lineNumber,
          message: `CROSS JOIN without a WHERE clause at line ${lineNumber}`,
          severity,
          suggestion: hasLimit
            ? "Add a WHERE clause to filter the cartesian product. LIMIT alone does not prevent full computation in Snowflake."
            : "Add a WHERE clause or replace with an INNER JOIN on a specific condition. Without filtering, this produces a full cartesian product.",
        })
      }
    }

    // Also detect implicit cross joins (comma-separated FROM without WHERE)
    const implicitCrossRegex =
      /\bFROM\s+(\w+\s*,\s*\w+(?:\s*,\s*\w+)*)\b/gi
    while ((match = implicitCrossRegex.exec(sql)) !== null) {
      const afterFrom = upperSql.substring(match.index)
      const hasWhere = /\bWHERE\b/.test(afterFrom)

      if (!hasWhere) {
        const lineNumber =
          sql.substring(0, match.index).split("\n").length
        findings.push({
          line: lineNumber,
          message: `Implicit CROSS JOIN (comma-separated tables) without WHERE at line ${lineNumber}`,
          severity: "warning",
          suggestion:
            "Use explicit JOIN syntax with ON conditions instead of comma-separated tables in FROM.",
        })
      }
    }

    return {
      passed: findings.length === 0,
      findingCount: findings.length,
      findings,
      summary:
        findings.length === 0
          ? "No CROSS JOIN anti-patterns detected."
          : `Found ${findings.length} potential CROSS JOIN anti-pattern(s).`,
    }
  },
})

export default definePlugin({
  name: "sql-antipattern-cross-join",
  description: "Detects CROSS JOIN anti-patterns in Snowflake SQL",
  tools: [crossJoinChecker],
  hooks: {
    onToolCall(call) {
      // Automatically check SQL when query tools are used
      if (
        call.name === "warehouse_query" &&
        typeof call.parameters?.sql === "string"
      ) {
        console.log(
          `[cross-join-checker] Scanning query for anti-patterns...`
        )
      }
    },
    onToolResult(result) {
      if (result.toolName === "check_cross_join_antipattern") {
        const output = result.output as { passed: boolean; summary: string }
        if (!output.passed) {
          console.warn(`[cross-join-checker] ${output.summary}`)
        }
      }
    },
  },
})
```

### Register It

Add the plugin path to your `altimate-code.json`:

```json
{
  "plugin": [
    "./plugins/sql-antipattern-cross-join"
  ]
}
```

Or place it directly in your project's `.altimate-code/plugins/` directory, where it will be loaded automatically.

### Use It

Once registered, the tool is available in any session:

```
> check_cross_join_antipattern sql:"SELECT * FROM orders CROSS JOIN customers"

Found 1 potential CROSS JOIN anti-pattern(s).
- Line 1: CROSS JOIN without a WHERE clause
  Suggestion: Add a WHERE clause or replace with an INNER JOIN on a specific condition.
```

## Testing Your Plugin

### Development Mode

Run your plugin tests using `bun test`:

```bash
cd plugins/sql-antipattern-cross-join
bun test
```

### Writing Unit Tests

Create a test file alongside your plugin:

```typescript
// plugins/sql-antipattern-cross-join/index.test.ts
import { describe, it, expect } from "bun:test"
import plugin from "./index"

describe("cross-join-antipattern", () => {
  const tool = plugin.tools[0]

  it("detects CROSS JOIN without WHERE", async () => {
    const result = await tool.execute({
      sql: "SELECT * FROM orders CROSS JOIN customers",
      severity: "error",
    })
    expect(result.passed).toBe(false)
    expect(result.findingCount).toBe(1)
    expect(result.findings[0].message).toContain("CROSS JOIN without a WHERE")
  })

  it("passes CROSS JOIN with WHERE", async () => {
    const result = await tool.execute({
      sql: "SELECT * FROM orders CROSS JOIN customers WHERE orders.id = customers.order_id",
      severity: "error",
    })
    expect(result.passed).toBe(true)
    expect(result.findingCount).toBe(0)
  })

  it("detects implicit cross join", async () => {
    const result = await tool.execute({
      sql: "SELECT * FROM orders, customers",
      severity: "warning",
    })
    expect(result.passed).toBe(false)
    expect(result.findings[0].message).toContain("Implicit CROSS JOIN")
  })

  it("handles clean SQL", async () => {
    const result = await tool.execute({
      sql: "SELECT o.id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id",
      severity: "error",
    })
    expect(result.passed).toBe(true)
  })
})
```

Run the tests:

```bash
bun test plugins/sql-antipattern-cross-join/index.test.ts
```

## Distributing Your Plugin

### Option 1: Local Directory

Place your plugin in the `.altimate-code/plugins/` directory of your project. Plugins in this directory are loaded automatically without explicit registration.

```
my-dbt-project/
  .altimate-code/
    plugins/
      sql-antipattern-cross-join/
        index.ts
        package.json
```

### Option 2: Git Repository

Publish your plugin as a git repository and reference it by URL:

```json
{
  "plugin": [
    "git+https://github.com/your-org/altimate-cross-join-checker.git"
  ]
}
```

### Option 3: npm Package

Publish your plugin to npm for the widest distribution:

```bash
# In your plugin directory
npm publish
```

Your `package.json` should include:

```json
{
  "name": "@your-org/altimate-plugin-cross-join",
  "version": "1.0.0",
  "main": "index.ts",
  "keywords": ["altimate-code-plugin"],
  "peerDependencies": {
    "@altimateai/altimate-code-plugin": ">=0.4.0"
  }
}
```

Then consumers install and register it:

```bash
npm install @your-org/altimate-plugin-cross-join
```

```json
{
  "plugin": ["@your-org/altimate-plugin-cross-join"]
}
```

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
