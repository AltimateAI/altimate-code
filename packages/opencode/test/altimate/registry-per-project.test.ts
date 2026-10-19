/**
 * The connection registry keeps one state per project directory.
 *
 * One server process serves several project directories (each request carries its own `Instance.directory`). The
 * registry used to be process-global, so the first project to load decided every project's connections, and closing
 * or reloading in one project closed another project's connectors. These tests drive two project directories in one
 * process, through `process.chdir` (the CLI path) and through `Instance.provide` (the server path).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ssh2 is an optional dependency that is not installed for tests; a fake client lets the real tunnel module run.
const sshClients: { host: string; ended: boolean }[] = []
mock.module("ssh2", () => ({
  Client: class {
    private handlers = new Map<string, (...args: unknown[]) => void>()
    private record = { host: "", ended: false }
    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers.set(event, cb)
      return this
    }
    connect(options: { host: string }) {
      this.record.host = options.host
      sshClients.push(this.record)
      queueMicrotask(() => this.handlers.get("ready")?.())
    }
    forwardOut(_a: string, _b: number, _c: string, _d: number, cb: (err?: Error) => void) {
      cb(new Error("no forwarding in tests"))
    }
    end() {
      this.record.ended = true
    }
  },
}))

import * as Registry from "../../src/altimate/native/connections/registry"
import { closeAllTunnels } from "../../src/altimate/native/connections/ssh-tunnel"
import { Instance } from "../../src/project/instance"

let projectA: string
let projectB: string
let home: string
let prevCwd: string
let prevHome: string | undefined
let ambientConnEnv: Record<string, string>

function writeLocal(dir: string, entries: Record<string, unknown>) {
  fs.mkdirSync(path.join(dir, ".altimate-code"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".altimate-code", "connections.json"), JSON.stringify(entries))
}

function writeGlobal(entries: Record<string, unknown>) {
  fs.mkdirSync(path.join(home, ".altimate-code"), { recursive: true })
  fs.writeFileSync(path.join(home, ".altimate-code", "connections.json"), JSON.stringify(entries))
}

function inProject<T>(dir: string, fn: () => T): T {
  process.chdir(dir)
  return fn()
}

beforeEach(() => {
  // Ambient connection env vars would leak the caller's shell into every assertion.
  ambientConnEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(Registry.CONN_ENV_PREFIX) || value === undefined) continue
    ambientConnEnv[key] = value
    delete process.env[key]
  }
  prevCwd = process.cwd()
  prevHome = process.env.OPENCODE_TEST_HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rpp-home-")))
  process.env.OPENCODE_TEST_HOME = home
  projectA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rpp-a-")))
  projectB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rpp-b-")))
  sshClients.length = 0
  Registry.reset()
})

afterEach(async () => {
  await Registry.closeAll()
  closeAllTunnels()
  Registry.reset()
  process.chdir(prevCwd)
  if (prevHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = prevHome
  for (const dir of [projectA, projectB, home]) fs.rmSync(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(Registry.CONN_ENV_PREFIX)) delete process.env[key]
  }
  Object.assign(process.env, ambientConnEnv)
})

describe("project-local connections are per project", () => {
  test("A's local entry is invisible to B, and B's to A (A loads first)", () => {
    writeLocal(projectA, { only_a: { type: "postgres", host: "a" } })
    writeLocal(projectB, { only_b: { type: "postgres", host: "b" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["only_a"])
    expect(inProject(projectB, () => Registry.names())).toEqual(["only_b"])
    expect(inProject(projectA, () => Registry.getConfig("only_b"))).toBeUndefined()
    expect(inProject(projectB, () => Registry.getConfig("only_a"))).toBeUndefined()
  })

  test("the same holds when B loads first", () => {
    writeLocal(projectA, { only_a: { type: "postgres", host: "a" } })
    writeLocal(projectB, { only_b: { type: "postgres", host: "b" } })
    expect(inProject(projectB, () => Registry.names())).toEqual(["only_b"])
    expect(inProject(projectA, () => Registry.names())).toEqual(["only_a"])
    expect(inProject(projectB, () => Registry.list().warehouses.map((w) => w.name))).not.toContain("only_a")
  })

  test("a file added late to one project is seen there only, in either order", () => {
    expect(inProject(projectA, () => Registry.names())).toEqual([])
    expect(inProject(projectB, () => Registry.names())).toEqual([])

    writeLocal(projectB, { late_b: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual([])
    expect(inProject(projectB, () => Registry.names())).toEqual(["late_b"])

    writeLocal(projectA, { late_a: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["late_a"])
    expect(inProject(projectB, () => Registry.names())).toEqual(["late_b"])
  })

  test("each project re-reads only while its own registry is empty", () => {
    writeLocal(projectA, { a1: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["a1"])
    expect(inProject(projectB, () => Registry.names())).toEqual([])

    // A is populated: an edit is not picked up. B is empty: its new file is.
    writeLocal(projectA, { a1: { type: "postgres" }, a2: { type: "postgres" } })
    writeLocal(projectB, { b1: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["a1"])
    expect(inProject(projectB, () => Registry.names())).toEqual(["b1"])
  })

  test("global and env entries are visible in both projects", () => {
    writeGlobal({ shared_global: { type: "postgres", host: "g" } })
    process.env.ALTIMATE_CODE_CONN_SHARED_ENV = JSON.stringify({ type: "postgres", host: "e" })
    writeLocal(projectA, { only_a: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names().sort())).toEqual(["only_a", "shared_env", "shared_global"])
    expect(inProject(projectB, () => Registry.names().sort())).toEqual(["shared_env", "shared_global"])
  })

  test("the server path: Instance.provide with two directories", async () => {
    writeLocal(projectA, { srv: { type: "postgres", host: "host-a" } })
    writeLocal(projectB, { srv: { type: "postgres", host: "host-b" } })
    const hostIn = (dir: string) =>
      Instance.provide({ directory: dir, fn: async () => Registry.getConfig("srv")?.host })
    expect(await hostIn(projectA)).toBe("host-a")
    expect(await hostIn(projectB)).toBe("host-b")
    expect(await hostIn(projectA)).toBe("host-a")
  })
})

describe("connectors are per project", () => {
  test("the same name resolves to each project's own config and connector", async () => {
    writeLocal(projectA, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    writeLocal(projectB, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    expect(inProject(projectA, () => Registry.getConfig("store")?.path)).toBe(path.join(projectA, "store.sqlite"))
    expect(inProject(projectB, () => Registry.getConfig("store")?.path)).toBe(path.join(projectB, "store.sqlite"))

    const a = await inProject(projectA, () => Registry.get("store"))
    await a.execute("CREATE TABLE marker_a (x INTEGER)")
    const b = await inProject(projectB, () => Registry.get("store"))
    expect(b).not.toBe(a)
    const tables = await b.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    expect(tables.rows.flat()).not.toContain("marker_a")
    // the cached connector is per project too
    expect(await inProject(projectA, () => Registry.get("store"))).toBe(a)
  })

  test("removing or reloading in B does not close A's connector", async () => {
    writeLocal(projectA, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    writeLocal(projectB, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    const a = await inProject(projectA, () => Registry.get("store"))
    await inProject(projectB, () => Registry.get("store"))

    await inProject(projectB, () => Registry.reload())
    expect((await a.execute("SELECT 1 AS one")).rows).toEqual([[1]])
    await inProject(projectB, () => Registry.remove("store"))
    expect((await a.execute("SELECT 1 AS one")).rows).toEqual([[1]])
    expect(await inProject(projectA, () => Registry.get("store"))).toBe(a)
    // B's local file still defines it, so B can connect again with a fresh connector
    const b2 = await inProject(projectB, () => Registry.get("store"))
    expect(b2).not.toBe(a)
  })

  test("same-named SSH tunnels are per project; removing in B leaves A's open", async () => {
    const tunnelled = (sshHost: string) => ({
      store: { type: "sqlite", path: "store.sqlite", create: true, ssh_host: sshHost, host: "db", port: 5432 },
    })
    writeLocal(projectA, tunnelled("bastion-a"))
    writeLocal(projectB, tunnelled("bastion-b"))
    await inProject(projectA, () => Registry.get("store"))
    await inProject(projectB, () => Registry.get("store"))
    // B starting its tunnel must not have closed A's
    expect(sshClients.map((c) => [c.host, c.ended])).toEqual([
      ["bastion-a", false],
      ["bastion-b", false],
    ])

    await inProject(projectB, () => Registry.remove("store"))
    expect(sshClients.map((c) => [c.host, c.ended])).toEqual([
      ["bastion-a", false],
      ["bastion-b", true],
    ])
  })

  test("a connect in flight when its project reloads is not cached over the reloaded state", async () => {
    writeLocal(projectA, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    const inflight = inProject(projectA, () => Registry.get("store"))
    await inProject(projectA, () => Registry.reload())
    await expect(inflight).rejects.toThrow("reloaded or removed while it was connecting")
    const fresh = await inProject(projectA, () => Registry.get("store"))
    expect((await fresh.execute("SELECT 1 AS one")).rows).toEqual([[1]])
  })
})

describe("warehouse_add keeps in-memory credentials in its project", () => {
  test("credentials added in A stay in A's state; B sees only the saved, sanitized entry", async () => {
    // The test preload disables the OS credential store, so the password is held in memory only.
    const added = await inProject(projectA, () =>
      Registry.add("added_pg", { type: "postgres", host: "h", user: "u", password: "s3cret-test" } as any),
    )
    expect(added.success).toBe(true)
    expect(inProject(projectA, () => Registry.getConfig("added_pg")?.password)).toBe("s3cret-test")

    const inB = inProject(projectB, () => Registry.getConfig("added_pg"))
    expect(inB?.host).toBe("h")
    expect(inB?.password).toBeUndefined()

    // switching back and forth does not lose A's in-memory credential
    expect(inProject(projectA, () => Registry.getConfig("added_pg")?.password)).toBe("s3cret-test")
  })
})

describe("test helpers", () => {
  test("setConfigs applies to every project until reset", () => {
    Registry.setConfigs({ injected: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["injected"])
    expect(inProject(projectB, () => Registry.names())).toEqual(["injected"])
    Registry.reset()
    writeLocal(projectA, { only_a: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["only_a"])
    expect(inProject(projectB, () => Registry.names())).toEqual([])
  })

  test("reset clears every project", () => {
    writeLocal(projectA, { only_a: { type: "postgres" } })
    expect(inProject(projectA, () => Registry.names())).toEqual(["only_a"])
    fs.rmSync(path.join(projectA, ".altimate-code"), { recursive: true })
    Registry.reset()
    expect(inProject(projectA, () => Registry.names())).toEqual([])
  })

  test("closeAll releases connectors cached under setConfigs after load()", async () => {
    Registry.setConfigs({ mem: { type: "sqlite", path: ":memory:" } })
    const injected = await Registry.get("mem")
    inProject(projectA, () => Registry.load())
    await Registry.closeAll()
    await expect(injected.execute("SELECT 1")).rejects.toThrow()
  })
})
