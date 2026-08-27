import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ensure, resetForTests, syncInternals } from "../../../src/altimate/workspace/engine-sync"
import { persistRestore } from "../../../src/altimate/workspace/engine-config"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
const A = { datamateId: 42, datamateName: "analytics", repoRemote: "x", projectPath: "/tmp/a" } as any
beforeEach(() => { process.env.ALTIMATE_WORKSPACE = "1"; resetForTests() })
afterEach(() => { for (const k of Object.keys(syncInternals) as any[]) delete (syncInternals as any)[k] })
function base(h: any) {
  syncInternals.resolveBinding = async () => A
  syncInternals.which = () => "/usr/local/bin/datamate"
  syncInternals.versionOf = async () => "0.7.0"
  syncInternals.declared = async () => ({ keys: [], extensionKeys: [] })
  syncInternals.persist = async (n, c) => { h.persisted.push(c); return "written" as const }
  syncInternals.projectConfigPath = async () => "/tmp/x/altimate-code.json"
  syncInternals.existingEntry = async () => h.entry
  syncInternals.notify = async (t) => { h.toasts.push(t) }
  syncInternals.toolsChanged = async () => {}
  syncInternals.persistRestore = async (_n, p) => { h.restores.push(p ?? null); return "restored" as const }
  const q = [{}, { datamate: { status: "connected" } }]
  syncInternals.mcp = {
    status: async () => (q.length > 1 ? q.shift()! : q[0]!) as any,
    add: async () => { h.added += 1 }, remove: async () => { h.removes += 1 },
    spawned: async () => undefined, tools: async () => ({}),
  }
}
describe("AQ — the undo's failed re-read writes nothing", () => {
  test("projectEntry throws at undo time: no restore write, one 'left behind' toast", async () => {
    const h = { persisted: [] as any[], restores: [] as any[], toasts: [] as any[], added: 0, removes: 0, entry: null as any }
    base(h)
    let reads = 0
    syncInternals.projectEntry = async () => { reads += 1; if (reads >= 2) throw new Error("EIO"); return null }
    const prevTools = syncInternals.mcp!.tools
    syncInternals.mcp!.tools = async () => { h.entry = { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false }; return prevTools() }
    const out = await ensure("s1")
    expect(out.kind).toBe("entry-disabled")
    expect(h.restores, "the undo wrote blind after its re-read failed").toHaveLength(0)
    expect(h.toasts.map((t: any) => t.title).some((t: string) => t.includes("left behind")), JSON.stringify(h.toasts.map((t: any) => t.title))).toBe(true)
  })
})
describe("AR — the restore's write honours a disable on disk (real file)", () => {
  test("previous non-null: a disabled node is not overwritten", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ar-")); const file = path.join(dir, "altimate-code.json")
    writeFileSync(file, JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false } } }, null, 2))
    const r = await persistRestore("datamate", { type: "local", command: ["datamate", "old"] } as any, file)
    expect(r).toBe("restored")
    const after = JSON.parse(readFileSync(file, "utf8"))
    expect(after.mcp.datamate.enabled, "overwrote a disabled node").toBe(false)
    expect(after.mcp.datamate.command).toEqual(["datamate", "start-stdio", "--datamate", "42"])
  })
  test("previous null (delete case): a disabled node is kept, not deleted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ar-")); const file = path.join(dir, "altimate-code.json")
    writeFileSync(file, JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: false } } }, null, 2))
    const r = await persistRestore("datamate", null, file)
    expect(r).toBe("restored")
    const after = JSON.parse(readFileSync(file, "utf8"))
    expect(after.mcp?.datamate?.enabled, "deleted the node the user disabled").toBe(false)
  })
  test("previous null, node enabled: removed as before", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ar-")); const file = path.join(dir, "altimate-code.json")
    writeFileSync(file, JSON.stringify({ mcp: { datamate: { type: "local", command: ["datamate", "start-stdio", "--datamate", "42"], enabled: true } } }, null, 2))
    await persistRestore("datamate", null, file)
    const after = JSON.parse(readFileSync(file, "utf8"))
    expect(after.mcp?.datamate).toBeUndefined()
  })
})
