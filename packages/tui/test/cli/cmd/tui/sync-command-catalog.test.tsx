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

      await wait(() => sync.commandStatus === "ready")
      expect(sync.data.command.map((item) => item.name)).toEqual(["cmd-ws_a"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a failed agent refresh keeps the agents already loaded for that workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let failAgents = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/agent") return
      if (!failAgents) return json([{ name: "builder", mode: "primary", permission: [], options: {} }])
      return held.then(() => new Response("<html>bad gateway</html>", { status: 502 }))
    }, tmp.path)

    try {
      expect(sync.agentStatus).toBe("ready")
      failAgents = true
      const refresh = sync.refreshAgents()
      expect(sync.agentStatus).toBe("loading")
      release()
      await expect(refresh).rejects.toThrow()
      expect(sync.agentStatus).toBe("ready")
      expect(sync.data.agent.map((agent) => agent.name)).toEqual(["builder"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a failed agent load for a new workspace is reported instead of reusing the previous agents", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, project, sync } = await mount((url) => {
      if (url.pathname !== "/agent") return
      if (url.searchParams.get("workspace") === "ws_a") return new Response("<html>bad gateway</html>", { status: 502 })
      return json([{ name: "builder", mode: "primary", permission: [], options: {} }])
    }, tmp.path)

    try {
      expect(sync.agentStatus).toBe("ready")
      project.workspace.set("ws_a")
      expect(sync.agentStatus).toBe("loading")
      await wait(() => sync.agentStatus === "failed")
    } finally {
      app.renderer.destroy()
    }
  })

  test("a workspace reset without a bootstrap reloads the command catalog", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, project, sync } = await mount((url) => {
      if (url.pathname !== "/command") return
      return json([command(`cmd-${url.searchParams.get("workspace") ?? "root"}`)])
    }, tmp.path)

    try {
      project.workspace.set("ws_a")
      await wait(() => sync.commandStatus === "ready" && sync.data.command[0]?.name === "cmd-ws_a")
      project.workspace.set(undefined)
      await wait(() => sync.commandStatus === "ready" && sync.data.command[0]?.name === "cmd-root")
    } finally {
      app.renderer.destroy()
    }
  })

  test("a failed command refresh keeps the list already loaded for that workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let fail = false
    const { app, sync } = await mount((url) => {
      if (url.pathname !== "/command") return
      if (fail) return new Response("<html>bad gateway</html>", { status: 502 })
      return json([command("review")])
    }, tmp.path)

    try {
      await wait(() => sync.commandStatus === "ready")
      fail = true
      await sync.refreshCommands()
      expect(sync.commandStatus).toBe("ready")
      expect(sync.data.command.map((item) => item.name)).toEqual(["review"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("a superseded agent request that fails does not fail the current load", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let holdFirst = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { app, project, sync } = await mount((url) => {
      if (url.pathname !== "/agent") return
      if (holdFirst && url.searchParams.get("workspace") === "ws_a")
        return held.then(() => new Response("<html>bad gateway</html>", { status: 502 }))
      return json([{ name: "builder", mode: "primary", permission: [], options: {} }])
    }, tmp.path)

    try {
      holdFirst = true
      project.workspace.set("ws_a")
      const stale = sync.refreshAgents()
      project.workspace.set("ws_b")
      release()
      await expect(stale).resolves.toBeUndefined()
      await wait(() => sync.agentStatus === "ready")
    } finally {
      app.renderer.destroy()
    }
  })
})
