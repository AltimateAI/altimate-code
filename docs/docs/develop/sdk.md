# SDK

The altimate SDK (`@altimateai/altimate-code-sdk`) provides a TypeScript client for programmatic access to altimate functionality.

## Installation

```bash
npm install @altimateai/altimate-code-sdk
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

## Exports

| Import | Description |
|--------|------------|
| `@altimateai/altimate-code-sdk` | Core SDK |
| `@altimateai/altimate-code-sdk/client` | HTTP client |
| `@altimateai/altimate-code-sdk/server` | Server utilities |
| `@altimateai/altimate-code-sdk/v2` | v2 API types |
| `@altimateai/altimate-code-sdk/v2/client` | v2 client |

## OpenAPI

The SDK is generated from an OpenAPI specification. The v2 client is auto-generated using `@hey-api/openapi-ts`.
