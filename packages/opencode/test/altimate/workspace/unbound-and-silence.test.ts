// altimate_change - new file
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ensure, resetForTests, syncInternals, planForEntry, settledOutcome } from "../../../src/altimate/workspace/engine-sync"

describe("a project with no workspace linked stays silent", () => {
  beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
  afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k] })

  test("an unbound project whose config read throws stays unbound and silent", async () => {
    const toasts: { title: string }[] = []
    syncInternals.resolveBinding = async () => null                       // unbound
    syncInternals.existingEntry = async () => { throw new Error("EACCES altimate-code.json") }
    syncInternals.notify = async (t) => { toasts.push(t) }
    syncInternals.mcp = { status: async () => ({ datamate: { status: "connected" } }), add: async () => {}, remove: async () => {}, tools: async () => ({}) }
    const out = await ensure("s1")
          void 0; console.log("AH unbound:", JSON.stringify(out), "| toasts:", toasts.map((t) => t.title), "| settled:", JSON.stringify(settledOutcome("s1")))
    expect(out.kind).toBe("unbound")
    expect(toasts).toHaveLength(0)
  })

  test("T phantom: entry null + synthesised status (key known to MCP but not to config)", () => {
    const noRuntime = planForEntry({ entry: null, observed: { status: "failed", error: "exit 1" }, runtime: undefined }, "42", false)
    const withRuntime = planForEntry({ entry: null, observed: { status: "connected" }, runtime: { type: "local", command: ["datamate", "start-stdio"] } }, "42", false)
    console.log("T phantom noRuntime:", JSON.stringify(noRuntime), "| withRuntime:", JSON.stringify(withRuntime))
  })

  test("an unbound project stays silent on every turn, not just the first", async () => {
    const toasts: { title: string }[] = []
    syncInternals.resolveBinding = async () => null
    syncInternals.existingEntry = async () => { throw new Error("EACCES altimate-code.json") }
    syncInternals.notify = async (t) => { toasts.push(t) }
    syncInternals.mcp = { status: async () => ({ datamate: { status: "connected" } }), add: async () => {}, remove: async () => {}, tools: async () => ({}) }
    await ensure("s1"); await ensure("s1"); await ensure("s1")
        // which could not fail and so protected nothing. An unbound project announces
    // nothing at all, on any turn, whatever fails inside it.
    expect(toasts, `an unbound project announced ${toasts.length} times`).toHaveLength(0)
  })
})
