import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { resetDatabase } from "./db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { Effect } from "effect"
import { pollWithTimeout } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("reference HttpApi", () => {
  // BUG: The legacy /api/reference route is no longer mounted on Server.Default();
  // it falls through to the app proxy before reference data can be resolved.
  test.todo("lists usable references resolved in the server workspace", async () => {
    await using tmp = await tmpdir({
      config: {
        formatter: false,
        lsp: false,
        references: {
          docs: "./docs",
          effect: { repository: "Effect-TS/effect", branch: "main" },
          bad: "not-a-repo",
        },
      },
    })

    const body = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await Server.Default().request("/api/reference", {
            headers: { "x-opencode-directory": tmp.path },
          })
          expect(response.status).toBe(200)
          const body = await response.json()
          return body.data.length === 0 ? undefined : body
        }),
        "references were not loaded",
      ),
    )
    expect(body).toMatchObject({ location: { directory: tmp.path } })
    expect(body.data).toEqual([
      {
        name: "docs",
        path: path.join(tmp.path, "docs"),
        source: {
          type: "local",
          path: path.join(tmp.path, "docs"),
        },
      },
      {
        name: "effect",
        path: path.join(Global.Path.repos, "github.com", "Effect-TS", "effect@main"),
        source: {
          type: "git",
          repository: "Effect-TS/effect",
          branch: "main",
        },
      },
    ])
  })
})
