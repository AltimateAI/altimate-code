// altimate: ALT-F01
import { Identity } from "@opencode/util/identity"
import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("expired browser pairing links name the selected host command", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const response = yield* Effect.promise(() =>
      handler(new Request("http://localhost/auth/connect/expired", { headers: { accept: "text/html" } })),
    )
    expect(response.status).toBe(401)
    expect(yield* Effect.promise(() => response.text())).toBe(
      `This pairing link expired or was already used. Run \`${Identity.app} pair\` to get a new one.`,
    )
  }),
)
