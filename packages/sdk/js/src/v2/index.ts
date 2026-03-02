export * from "./client.js"
export * from "./server.js"

import { createAltimateClient } from "./client.js"
import { createAltimateServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createAltimate(options?: ServerOptions) {
  const server = await createAltimateServer({
    ...options,
  })

  const client = createAltimateClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
