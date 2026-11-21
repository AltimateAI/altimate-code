/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const command = (name: string) => ({ name, template: "", hints: [] })

describe("tui sync command catalog", () => {
  test("a failed command request is reported as failed and a later refresh recovers", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let fail = true
    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/command") return
      if (fail) return new Response("<html>bad gateway</html>", { status: 502 })
      return json([command("review")])
    }, tmp.path)

    try {
      await wait(() => sync.commandStatus === "failed")
      expect(sync.data.command).toEqual([])

      fail = false
      await sync.refreshCommands()
      expect(sync.commandStatus).toBe("ready")
      expect(sync.data.command.map((item) => item.name)).toEqual(["review"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a workspace switch keeps commands pending until that workspace's catalog arrives", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, project, sync } = await mount((url) => {
      if (url.pathname !== "/command") return
      return json([command(`cmd-${url.searchParams.get("workspace") ?? "root"}`)])
    }, tmp.path)

    try {
      await wait(() => sync.commandStatus === "ready")
      expect(sync.data.command.map((item) => item.name)).toEqual(["cmd-root"])

      project.workspace.set("ws_a")
      expect(sync.commandStatus).toBe("loading")

      await sync.refreshCommands()
      expect(sync.commandStatus).toBe("ready")
      expect(sync.data.command.map((item) => item.name)).toEqual(["cmd-ws_a"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a failed agent refresh releases the agent wait and keeps the previous agents", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let failAgents = false
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname !== "/agent") return
      if (failAgents) return new Response("<html>bad gateway</html>", { status: 502 })
      return json([{ name: "builder", mode: "primary", permission: [], options: {} }])
    }, tmp.path)
    const swallow = () => {}
    process.on("unhandledRejection", swallow)

    try {
      expect(sync.data.agentsLoading).toBe(false)
      failAgents = true
      emit({
        directory: "/tmp/opencode/packages/tui",
        project: "proj_test",
        payload: { id: "evt_disposed", type: "server.instance.disposed", properties: { directory: "/tmp/opencode" } },
      } as Parameters<typeof emit>[0])
      await wait(() => sync.data.agentsLoading === true, 500).catch(() => {})
      await wait(() => sync.data.agentsLoading === false)
      expect(sync.data.agent.map((agent) => agent.name)).toEqual(["builder"])
    } finally {
      process.off("unhandledRejection", swallow)
      app.renderer.destroy()
    }
  })
})
