// Round-3 AH/T probes — NOT for commit.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals, planForEntry, settledOutcome } from "../../../src/altimate/workspace/engine-sync"
beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
afterEach(() => { for (const k of Object.keys(syncInternals) as Array<keyof typeof syncInternals>) delete syncInternals[k] })

test("AH: UNBOUND project, config read throws in the diagnostic branch → must stay `unbound` and silent", async () => {
  const toasts: { title: string }[] = []
  syncInternals.resolveBinding = async () => null                       // unbound
  syncInternals.existingEntry = async () => { throw new Error("EACCES altimate-code.json") }
  syncInternals.notify = async (t) => { toasts.push(t) }
  syncInternals.mcp = { status: async () => ({ datamate: { status: "connected" } }), add: async () => {}, remove: async () => {}, tools: async () => ({}) }
  const out = await ensure("s1")
  console.log("AH unbound:", JSON.stringify(out), "| toasts:", toasts.map((t) => t.title), "| settled:", JSON.stringify(settledOutcome("s1")))
  expect(out.kind).toBe("unbound")
  expect(toasts).toHaveLength(0)
})

test("T phantom: entry null + synthesised status (key known to MCP but not to config)", () => {
  const noRuntime = planForEntry({ entry: null, observed: { status: "failed", error: "exit 1" }, runtime: undefined }, "42", false)
  const withRuntime = planForEntry({ entry: null, observed: { status: "connected" }, runtime: { type: "local", command: ["datamate", "start-stdio"] } }, "42", false)
  console.log("T phantom noRuntime:", JSON.stringify(noRuntime), "| withRuntime:", JSON.stringify(withRuntime))
})

test("AH: the unbound escalation repeats every turn (connect-failed is REPAIRABLE)", async () => {
  const toasts: { title: string }[] = []
  syncInternals.resolveBinding = async () => null
  syncInternals.existingEntry = async () => { throw new Error("EACCES altimate-code.json") }
  syncInternals.notify = async (t) => { toasts.push(t) }
  syncInternals.mcp = { status: async () => ({ datamate: { status: "connected" } }), add: async () => {}, remove: async () => {}, tools: async () => ({}) }
  await ensure("s1"); await ensure("s1"); await ensure("s1")
  console.log("AH repeat: toasts over 3 turns =", toasts.length, toasts.map((t) => t.title))
})
