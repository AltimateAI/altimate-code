import { afterEach, describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { WorkspaceServer } from "../../src/control-plane/workspace-server/server"
import { parseSSE } from "../../src/control-plane/sse"
import { GlobalBus } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

describe("control-plane/workspace-server SSE", () => {
  // InstanceBootstrap (git ops, LSP init) can take 10–20s under full-suite load
  test("streams GlobalBus events and parseSSE reads them", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = WorkspaceServer.App()
    const stop = new AbortController()
    const seen: unknown[] = []
    try {
      const response = await app.request("/event", {
        signal: stop.signal,
        headers: {
          "x-opencode-workspace": "wrk_test_workspace",
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(200)
      expect(response.body).toBeDefined()

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for workspace.test event"))
        }, 20000)

        void parseSSE(response.body!, stop.signal, (event) => {
          seen.push(event)
          const next = event as { type?: string }
          if (next.type === "server.connected") {
            GlobalBus.emit("event", {
              payload: {
                type: "workspace.test",
                properties: { ok: true },
              },
            })
            return
          }
          if (next.type !== "workspace.test") return
          clearTimeout(timeout)
          resolve()
        }).catch((error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      await done

      expect(seen.some((event) => (event as { type?: string }).type === "server.connected")).toBe(true)
      // altimate_change — the workspace SSE pipeline now stamps each forwarded event with a
      // sequence `id` (evt_…), so match on the meaningful payload (type + properties) rather than
      // an exact object that omits the server-assigned id.
      expect(
        seen.some((event) => {
          const next = event as { type?: string; properties?: unknown }
          return (
            next.type === "workspace.test" &&
            JSON.stringify(next.properties) === JSON.stringify({ ok: true })
          )
        }),
      ).toBe(true)
    } finally {
      stop.abort()
    }
  }, { timeout: 30000 })
})
