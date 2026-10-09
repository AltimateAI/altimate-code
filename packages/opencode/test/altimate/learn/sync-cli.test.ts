// altimate_change - new file
//
// Lesson sync through the real CLI: `enable --sync` / `disable --sync`, `status --json`, `show` markers,
// `promote --publish` refused, and `learn sync` against the contract server (with the legacy playbook warning).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { canonical, type Lesson } from "../../../src/altimate/learn/lesson"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import { tmpdir } from "../../fixture/fixture"
import { checkout, startServer, type Server } from "./sync-fixture"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")
const REMOTE = "git@github.com:acme/analytics.git"
const lesson = (id: string, text: string): Lesson => ({
  id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
  created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z",
})

async function learn(cwd: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, "learn", ...args], {
    cwd,
    env: {
      ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1",
      OPENCODE_TEST_STATE_HOME: path.join(cwd, "state"), ALTIMATE_LEARN: "", ALTIMATE_LEARN_SYNC: "",
      ALTIMATE_DISABLE_WORKSPACE: "0", ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

describe("learn CLI with sync", () => {
  test("enable --sync writes learn.sync; disable --sync turns off only sync", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ learn: {} }))
    const read = async () => parseJsonc(await fs.readFile(file, "utf8")).learn
    const enabled = await learn(dir.path, ["enable", "--sync"])
    expect(enabled.code).toBe(0)
    expect(await read()).toEqual({ capture: true, auto_reflect: true, sync: true })
    expect(enabled.stdout).toContain("Lesson sync: on")
    const status = JSON.parse((await learn(dir.path, ["status", "--json"])).stdout)
    expect(status.sync).toMatchObject({ enabled: true, workspace: null, outbox: { queued: 0, held: [] } })

    const overridden = await learn(dir.path, ["enable", "--sync"], { ALTIMATE_DISABLE_WORKSPACE: "1" })
    expect(overridden.stdout).toContain("Lesson sync stays off")

    const disabled = await learn(dir.path, ["disable", "--sync"])
    expect(disabled.code).toBe(0)
    expect(await read()).toEqual({ capture: true, auto_reflect: true, sync: false })
    expect(disabled.stdout).toContain("Lesson sync disabled")
    expect(JSON.parse((await learn(dir.path, ["status", "--json"])).stdout).sync.enabled).toBe(false)
  }, 120_000)

  test("promote --publish is refused while sync is on", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({ learn: { sync: true } }))
    await Store.saveCandidate(dir.path, Playbook.DEFAULT_NAME, Playbook.withBullets(Playbook.create({ name: Playbook.DEFAULT_NAME }), [
      { id: "L-0001", text: "Prefer explicit column lists.", helpful: 0, harmful: 0 },
    ]))
    const result = await learn(dir.path, ["promote", "--yes", "--publish"])
    expect(result.code).not.toBe(0)
    expect(result.stderr + result.stdout).toContain("review queue")
    expect(await Store.readPromoted(dir.path, Playbook.DEFAULT_NAME)).toBeUndefined()
  }, 60_000)

  test("learn sync without sync on, or without an account, says why", async () => {
    await using dir = await tmpdir({ git: true })
    const off = await learn(dir.path, ["sync"])
    expect(off.code).not.toBe(0)
    expect(off.stderr + off.stdout).toContain("Lesson sync is off")
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "learn-sync-empty-home-"))
    try {
      const signedOut = await learn(dir.path, ["sync"], { ALTIMATE_LEARN_SYNC: "1", OPENCODE_TEST_HOME: home })
      expect(signedOut.code).not.toBe(0)
      expect(signedOut.stderr + signedOut.stdout).toContain("not signed in")
    } finally { await fs.rm(home, { recursive: true, force: true }) }
  }, 60_000)
})

describe("learn sync against the workspace", () => {
  let server: Server
  let home: string
  let root: string
  beforeEach(async () => {
    server = startServer()
    server.bindings.set(REMOTE, server.datamateId)
    home = await fs.mkdtemp(path.join(os.tmpdir(), "learn-sync-cli-home-"))
    await fs.mkdir(path.join(home, ".altimate"), { recursive: true })
    await fs.writeFile(path.join(home, ".altimate", "altimate.json"), JSON.stringify({ altimateUrl: server.url, altimateInstanceName: "acme", altimateApiKey: "key-a" }))
    root = await checkout(REMOTE)
    await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ learn: { sync: true } }))
  })
  afterEach(async () => {
    server.stop()
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  })

  test("pulls, uploads the first sync, marks lessons, and warns about a published playbook skill", async () => {
    const p = Store.paths(root, Playbook.DEFAULT_NAME)
    await fs.mkdir(p.learnDir, { recursive: true })
    await fs.writeFile(p.approved, canonical([lesson("L-0a01", "Prefix staging models with stg_."), lesson("L-0a02", "Keep amount_cents as integers.")]))
    server.add({ lesson_key: "L-0a01", text: "Prefix staging models with stg_." }, REMOTE)
    server.add({ lesson_key: "L-0b01", text: "Workspace-wide rule about mart grain." })
    const skill = path.join(root, ".altimate-code", "skill", "_workspace", "team-playbook")
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(skill, "SKILL.md"), `---\nname: team-playbook\n---\n${Playbook.HEADER}\n`)

    const env = { OPENCODE_TEST_HOME: home }
    const synced = await learn(root, ["sync"], env)
    expect(synced.code).toBe(0)
    expect(synced.stdout).toContain("Pull team-playbook: ok (2 team lessons")
    expect(synced.stdout).toContain("1 submitted for review")
    expect(synced.stdout).toContain("1 existing lessons queued (first sync)")
    expect(synced.stdout).toContain(`learn-managed playbook skill "team-playbook"`)
    expect(server.rows.filter((r) => r.status === "candidate").map((r) => [r.lesson_key, r.origin])).toEqual([["L-0a02", "backfill"]])

    const shown = await learn(root, ["show"], env)
    expect(shown.stdout).toContain("[L-0a01] Prefix staging models with stg_. (team)")
    expect(shown.stdout).toContain("[L-0a02] Keep amount_cents as integers. (pending review)")
    expect(shown.stdout).toContain("# Team")
    expect(shown.stdout).toContain("Workspace-wide rule about mart grain. (team; workspace-wide)")

    const pushed = await learn(root, ["push"], env)
    expect(pushed.code).toBe(0)
    expect(pushed.stdout).toContain("0 submitted for review")
    // The review queue size comes with the next pull.
    expect((await learn(root, ["sync"], env)).code).toBe(0)
    const status = JSON.parse((await learn(root, ["status", "--json"], env)).stdout)
    expect(status.sync).toMatchObject({ enabled: true, workspace: { id: server.datamateId }, team_lessons: 2, pending_review: 1, backfill: { complete: true } })
    expect((await learn(root, ["status"], env)).stdout).toContain("Lesson sync: on")

    // The owner retires a lesson the project still has locally: it is hidden and says so.
    server.retire(server.rows.find((r) => r.lesson_key === "L-0a01")!.public_id)
    expect((await learn(root, ["sync"], env)).stdout).toContain("1 retired here")
    expect((await learn(root, ["show"], env)).stdout).toContain("[L-0a01] Prefix staging models with stg_. (retired by team — not delivered)")
    const retired = JSON.parse((await learn(root, ["status", "--json"], env)).stdout)
    expect(retired.sync.hidden_local).toEqual([{ lesson_key: "L-0a01", reason: "retired by team — not delivered" }])
  }, 120_000)
})
