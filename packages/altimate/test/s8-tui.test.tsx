import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer, PanelInput, SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import AltimateTui from "../src/tui"
import { createFixture, createHost } from "./lib/host"

test("S8. /warehouse opens its panel and the production component renders SDK RPC rows at narrow and wide widths", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({ directory: fixture.path })
  const session = await host.createSession()
  await host.run(session.id, [
    { tool: "warehouse_add", id: "warehouse", input: { name: "analytics", path: ":memory:" } },
    {
      tool: "sql_execute",
      id: "query",
      input: { warehouse: "analytics", sql: "SELECT 42 AS answer, 'duck' AS label, NULL AS missing" },
    },
  ])

  const layers: KeymapLayer[] = []
  const claims: SlotClaim<"session.panel">[] = []
  const opened: string[] = []
  const color = RGBA.fromInts(200, 200, 200)
  const subscriptions = { added: 0, removed: 0 }
  const context = {
    client: host.opencode,
    location: session.location,
    data: {
      session: { get: () => session },
      on: () => {
        subscriptions.added++
        return () => {
          subscriptions.removed++
        }
      },
    },
    theme: { text: { base: color, muted: color, feedback: { error: { base: color } } } },
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()) },
    ui: {
      panel: {
        open: (name: string) => {
          opened.push(name)
          return true
        },
      },
      slot: (claim: SlotClaim) => {
        if (claim.append === "session.panel") claims.push(claim)
        return () => {}
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await AltimateTui.setup(context)
  const command = layers.flatMap((layer) => layer.commands ?? []).find((command) => command.slash?.name === "warehouse")
  expect(command?.id).toBe("altimate.warehouse")
  await command!.run()
  expect(opened).toEqual(["altimate.warehouse"])
  expect(claims).toHaveLength(1)

  for (const width of [42, 110]) {
    const panel: PanelInput = {
      name: "altimate.warehouse",
      sessionID: session.id,
      width,
      presentation: width < 80 ? "fullscreen" : "panel",
      focused: true,
      focus() {},
      close() {},
      toggleFullscreen() {},
    }
    const app = await testRender(() => claims[0].render(panel), { width, height: 20 })
    try {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        await app.renderOnce()
        if (app.captureCharFrame().includes("42 | duck | NULL")) break
        await Bun.sleep(10)
      }
      const frame = app.captureCharFrame()
      expect(frame).toContain("Warehouses")
      expect(frame).toContain("analytics (duckdb)")
      expect(frame).toContain("Last query result")
      expect(frame).toContain("answer | label | missing")
      expect(frame).toContain("42 | duck | NULL")
      expect(frame).toContain("analytics · 1 row")
    } finally {
      app.renderer.destroy()
    }
  }
  expect(subscriptions).toEqual({ added: 2, removed: 2 })
  if (cleanup) await cleanup()
}, 30_000)

test("S8. /warehouse explains that a session is required when the panel cannot open", async () => {
  const layers: KeymapLayer[] = []
  const messages: string[] = []
  const context = {
    keymap: { layer: (factory: () => KeymapLayer) => layers.push(factory()) },
    ui: {
      panel: { open: () => false },
      toast: { show: (input: { message: string }) => messages.push(input.message) },
      slot: () => () => {},
    },
  } as unknown as Plugin.Context
  const cleanup = await AltimateTui.setup(context)
  await layers[0].commands![0].run()
  expect(messages).toEqual(["Open a session to view warehouses."])
  if (cleanup) await cleanup()
})
