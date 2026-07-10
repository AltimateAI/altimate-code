import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { resetDatabase } from "./db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

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

    const response = await Server.Default().request("/api/reference", {
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ location: { directory: tmp.path } })
    expect(body.data).toEqual([
      {
        name: "docs",
        path: path.join(tmp.path, "docs"),
        description: null,
        hidden: null,
        source: {
          type: "local",
          path: path.join(tmp.path, "docs"),
          description: null,
          hidden: null,
        },
      },
      {
        name: "effect",
        path: path.join(Global.Path.repos, "github.com", "Effect-TS", "effect"),
        description: null,
        hidden: null,
        source: {
          type: "git",
          repository: "Effect-TS/effect",
          branch: "main",
          description: null,
          hidden: null,
        },
      },
    ])
  })
})
