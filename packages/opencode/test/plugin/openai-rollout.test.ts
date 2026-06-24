import { describe, test } from "bun:test"

describe.skip("plugin.openai.websocket rollout", () => {
  // Removed upstream: websocket rollout is no longer exposed as a Plugin-level helper.
  test("legacy experimentalWebSocketsEnabled helper was removed; websocket enablement is now passed through CodexAuthPlugin options", () => {})
})
