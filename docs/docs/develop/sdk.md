# SDK

The altimate SDK (`@altimateai/altimate-code-sdk`) provides a TypeScript client for programmatic access to altimate functionality. Use it to automate SQL analysis, manage sessions, and integrate altimate into your CI/CD pipelines or internal tools.

## Installation

```bash
npm install @altimateai/altimate-code-sdk
```

## Starting the Server

Before using the SDK, you need a running altimate server. Start it with:

```bash
# Start the server on the default port (3000)
altimate serve

# Start on a custom port
altimate serve --port 8080

# Start with a specific config file
altimate serve --config ./altimate-code.json
```

Verify the server is running by hitting the health check endpoint:

```bash
curl http://localhost:3000/health
# => {"status":"ok"}
```

## Client Usage

```typescript
import { createClient } from "@altimateai/altimate-code-sdk/client"

const client = createClient({
  baseURL: "http://localhost:3000",
  username: "admin",
  password: "secret",
})

// Send a message
const response = await client.send({
  message: "analyze my top 10 most expensive queries",
  agent: "analyst",
})

// List sessions
const sessions = await client.sessions.list()
```

## Complete Integration Example

The following example demonstrates a full workflow: starting a session, running a SQL analysis task, reading the structured result, and handling errors.

```typescript
import { createClient } from "@altimateai/altimate-code-sdk/client"

async function analyzeExpensiveQueries() {
  const client = createClient({
    baseURL: "http://localhost:3000",
    username: "admin",
    password: "secret",
  })

  // Step 1: Create a new session
  const session = await client.sessions.create({
    agent: "analyst",
    metadata: { project: "analytics-pipeline" },
  })

  try {
    // Step 2: Send an analysis request within the session
    const response = await client.send({
      sessionId: session.id,
      message: "Find the top 10 most expensive queries by credit consumption in the last 30 days",
      agent: "analyst",
    })

    // Step 3: Read the structured result
    console.log("Analysis complete:")
    console.log("Response:", response.content)

    if (response.toolResults) {
      for (const result of response.toolResults) {
        console.log(`Tool: ${result.toolName}`)
        console.log(`Output:`, JSON.stringify(result.output, null, 2))
      }
    }

    // Step 4: Ask a follow-up question in the same session
    const followUp = await client.send({
      sessionId: session.id,
      message: "Which of those queries could benefit from clustering keys?",
      agent: "analyst",
    })

    console.log("Follow-up:", followUp.content)

    return { response, followUp }
  } finally {
    // Step 5: Always close the session when done
    await client.sessions.close(session.id)
  }
}

analyzeExpensiveQueries().catch(console.error)
```

## Session Management

Sessions maintain conversation context, which is important for multi-turn interactions and batch workflows.

```typescript
// Create a session with metadata for tracking
const session = await client.sessions.create({
  agent: "analyst",
  metadata: { pipeline: "nightly-audit", runId: "2025-01-15" },
})

// Reuse the session for multiple related messages
await client.send({ sessionId: session.id, message: "List all tables in ANALYTICS.PUBLIC" })
await client.send({ sessionId: session.id, message: "Which tables have no primary key?" })

// List all active sessions
const activeSessions = await client.sessions.list()
console.log(`Active sessions: ${activeSessions.length}`)

// Close the session to release resources
await client.sessions.close(session.id)
```

**Batch workflow tip:** When processing many projects or warehouses, create one session per unit of work and close each when done. This keeps memory usage predictable and ensures context does not leak between unrelated analyses.

## Error Handling

The SDK throws typed errors that you can catch and handle:

```typescript
import { createClient } from "@altimateai/altimate-code-sdk/client"
import {
  ConnectionError,
  AuthenticationError,
  SessionNotFoundError,
  RateLimitError,
  ServerError,
} from "@altimateai/altimate-code-sdk"

const client = createClient({
  baseURL: "http://localhost:3000",
  username: "admin",
  password: "secret",
})

try {
  const response = await client.send({
    message: "analyze warehouse costs",
    agent: "analyst",
  })
} catch (error) {
  if (error instanceof ConnectionError) {
    // Server is not running or unreachable
    console.error("Cannot reach altimate server. Is it running?", error.message)
  } else if (error instanceof AuthenticationError) {
    // Invalid credentials
    console.error("Invalid username or password")
  } else if (error instanceof SessionNotFoundError) {
    // Session expired or does not exist
    console.error("Session not found — it may have expired", error.sessionId)
  } else if (error instanceof RateLimitError) {
    // Too many requests — back off and retry
    console.error(`Rate limited. Retry after ${error.retryAfterMs}ms`)
    await new Promise((r) => setTimeout(r, error.retryAfterMs))
  } else if (error instanceof ServerError) {
    // Internal server error
    console.error("Server error:", error.statusCode, error.message)
  } else {
    throw error // Re-throw unexpected errors
  }
}
```

## Exports

| Import | Description |
|--------|------------|
| `@altimateai/altimate-code-sdk` | Core SDK — error types, constants, utilities |
| `@altimateai/altimate-code-sdk/client` | HTTP client — `createClient()` |
| `@altimateai/altimate-code-sdk/server` | Server utilities — for embedding altimate in your own server |
| `@altimateai/altimate-code-sdk/v2` | v2 API types — TypeScript type definitions |
| `@altimateai/altimate-code-sdk/v2/client` | v2 client — auto-generated typed client |

## OpenAPI

The SDK is generated from an OpenAPI specification. The v2 client is auto-generated using `@hey-api/openapi-ts`.

When the server is running, you can access the live OpenAPI spec at:

```
http://localhost:PORT/openapi.json
```

This is useful for exploring available endpoints, generating clients in other languages, or importing into tools like Postman or Insomnia.

> **For contributors:** If you make changes to the API (e.g., `packages/opencode/src/server/server.ts`), run `./script/generate.ts` to regenerate the SDK and related files. See [CONTRIBUTING.md](https://github.com/AltimateAI/altimate-code/blob/main/CONTRIBUTING.md) for details.
