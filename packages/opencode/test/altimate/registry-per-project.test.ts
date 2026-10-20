/**
 * The connection registry keeps one state per project directory.
 *
 * One server process serves several project directories (each request carries its own `Instance.directory`). The
 * registry used to be process-global, so the first project to load decided every project's connections, and closing
 * or reloading in one project closed another project's connectors. These tests drive two project directories in one
 * process, through `process.chdir` (the CLI path) and through `Instance.provide` (the server path).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as net from "net"
import { EventEmitter } from "events"
import { PassThrough } from "stream"

// ssh2 is an optional dependency, normally not installed for tests; a fake client lets the real tunnel module run.
// Bun's mock.module leaks across test files, so the genuine module (or its absence) is restored in afterAll.
let genuineSsh2: unknown
try {
  // @ts-expect-error — optional dependency
  genuineSsh2 = await import("ssh2")
} catch {
  genuineSsh2 = undefined
}
afterAll(() => {
  // Absent: a module cannot be un-mocked, so later files get a client that fails loudly instead of this fake.
  mock.module("ssh2", () =>
    genuineSsh2
      ? (genuineSsh2 as Record<string, unknown>)
      : {
          Client: class {
            constructor() {
              throw new Error("Cannot find package 'ssh2'")
            }
          },
        },
  )
})

const sshClients: { host: string; ended: boolean }[] = []
/** Hosts whose SSH `ready` is held until the test releases it. */
const heldReady = new Map<string, () => void>()
/** Simulates the SSH server closing the connection cleanly (no error event). */
const remoteClose = new Map<string, () => void>()
let forwardedStream: PassThrough | undefined
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
      const ready = () => this.handlers.get("ready")?.()
      remoteClose.set(options.host, () => this.handlers.get("close")?.())
      if (options.host.startsWith("held-")) heldReady.set(options.host, ready)
      else queueMicrotask(ready)
    }
    forwardOut(_a: string, _b: number, _c: string, _d: number, cb: (err?: Error, stream?: PassThrough) => void) {
      if (forwardedStream) cb(undefined, forwardedStream)
      else cb(new Error("no forwarding in tests"))
    }
    end() {
      this.record.ended = true
    }
  },
}))

import * as Registry from "../../src/altimate/native/connections/registry"
import { openTunnel, closeAllTunnels, openTunnelCount } from "../../src/altimate/native/connections/ssh-tunnel"
import { Instance } from "../../src/project/instance"
import { disposeInstance } from "../../src/effect/instance-registry"

/** Wait (bounded) until the fake SSH client for `host` has connected. */
async function sshConnected(host: string) {
  for (let i = 0; i < 500 && !sshClients.some((c) => c.host === host); i++) await new Promise((r) => setTimeout(r, 2))
  expect(sshClients.some((c) => c.host === host)).toBe(true)
}

const ended = (host: string) => sshClients.filter((c) => c.host === host).map((c) => c.ended)

function sshStore(sshHost: string, extra: Record<string, unknown> = {}) {
  return { type: "sqlite", path: "store.sqlite", create: true, ssh_host: sshHost, host: "db", port: 5432, ...extra }
}

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
  forwardedStream = undefined
  sshClients.length = 0
  heldReady.clear()
  remoteClose.clear()
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

describe("SSH forwarding errors", () => {
  for (const side of ["local", "remote"] as const) {
    test(`${side} socket errors destroy both forwarding endpoints without throwing`, async () => {
      const stream = new PassThrough()
      forwardedStream = stream
      let accept: ((socket: net.Socket) => void) | undefined
      const server = Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        address: () => ({ port: 12345 }),
        close: () => {},
      })
      const createServer = spyOn(net, "createServer").mockImplementation(((listener: (socket: net.Socket) => void) => {
        accept = listener
        return server
      }) as typeof net.createServer)
      const tunnel = openTunnel({ ssh_host: "forwarding", host: "db", port: 5432 })
      const local = new net.Socket()
      try {
        await tunnel.ready
        expect(accept).toBeDefined()
        accept!(local)
        const endpoint = side === "local" ? local : stream
        expect(() => endpoint.emit("error", new Error("ECONNRESET"))).not.toThrow()
        expect(local.destroyed).toBe(true)
        expect(stream.destroyed).toBe(true)
      } finally {
        local.destroy()
        tunnel.close()
        createServer.mockRestore()
      }
    })
  }
})

describe("each connect attempt owns its SSH tunnel", () => {
  test("a stale tunnel start that finishes after a newer start never publishes or closes the newer tunnel", async () => {
    writeLocal(projectA, { store: sshStore("held-old") })
    const stale = inProject(projectA, () => Registry.get("store"))
    await sshConnected("held-old")

    // replace the config while the old tunnel is still opening; the new attempt connects through its own tunnel
    const added = await inProject(projectA, () => Registry.add("store", sshStore("new") as any))
    expect(added.success).toBe(true)
    await expect(stale).rejects.toThrow()
    const fresh = await inProject(projectA, () => Registry.get("store"))

    // the old SSH handshake completes late: nothing is registered, the newer tunnel stays open
    heldReady.get("held-old")?.()
    await new Promise((r) => setTimeout(r, 5))
    expect(ended("held-old")).toEqual([true])
    expect(ended("new")).toEqual([false])
    expect(openTunnelCount()).toBe(1)
    expect((await fresh.execute("SELECT 1 AS one")).rows).toEqual([[1]])
  })

  test("a failing attempt closes only the tunnel it opened", async () => {
    writeLocal(projectB, { store: sshStore("b-host") })
    await inProject(projectB, () => Registry.get("store"))
    // same name in A, store missing and not creatable: the driver fails after A's tunnel opened
    writeLocal(projectA, { store: sshStore("a-host", { create: false, path: "missing.sqlite" }) })
    await expect(inProject(projectA, () => Registry.get("store"))).rejects.toThrow("not found")
    expect(ended("a-host")).toEqual([true])
    expect(ended("b-host")).toEqual([false])
    expect(openTunnelCount()).toBe(1)
  })

  test("replacing an SSH connection with a non-SSH one closes the old tunnel (cached and in flight)", async () => {
    writeLocal(projectA, { store: sshStore("cached-host"), other: sshStore("held-pending", { path: "other.sqlite" }) })
    await inProject(projectA, () => Registry.get("store"))
    const pending = inProject(projectA, () => Registry.get("other"))
    await sshConnected("held-pending")

    const plain = { type: "sqlite", path: "plain.sqlite", create: true } as any
    await inProject(projectA, () => Registry.add("store", plain))
    await inProject(projectA, () => Registry.add("other", plain))
    await expect(pending).rejects.toThrow()
    expect(ended("cached-host")).toEqual([true])
    expect(ended("held-pending")).toEqual([true])
    expect(openTunnelCount()).toBe(0)
    const store = await inProject(projectA, () => Registry.get("store"))
    expect((await store.execute("SELECT 1 AS one")).rows).toEqual([[1]])
    expect(openTunnelCount()).toBe(0)
  })

  test("a clean SSH disconnect before ready fails the connect and leaves no tunnel", async () => {
    writeLocal(projectA, { store: sshStore("held-closing") })
    const pending = inProject(projectA, () => Registry.get("store"))
    await sshConnected("held-closing")
    remoteClose.get("held-closing")?.()
    await expect(pending).rejects.toThrow("SSH connection closed")
    expect(openTunnelCount()).toBe(0)
  })

  test("reload with a pending SSH connect closes that attempt's tunnel", async () => {
    writeLocal(projectA, { store: sshStore("held-reload") })
    const pending = inProject(projectA, () => Registry.get("store"))
    await sshConnected("held-reload")
    await inProject(projectA, () => Registry.reload())
    await expect(pending).rejects.toThrow()
    expect(ended("held-reload")).toEqual([true])
    expect(openTunnelCount()).toBe(0)
  })
})

describe("instance disposal", () => {
  test("disposing a project's instance closes its connectors and tunnels only", async () => {
    writeLocal(projectA, { store: sshStore("a-host") })
    writeLocal(projectB, { store: sshStore("b-host") })
    const a = await inProject(projectA, () => Registry.get("store"))
    const b = await inProject(projectB, () => Registry.get("store"))

    await disposeInstance(projectA)
    expect(ended("a-host")).toEqual([true])
    expect(ended("b-host")).toEqual([false])
    await expect(a.execute("SELECT 1")).rejects.toThrow()
    expect((await b.execute("SELECT 1 AS one")).rows).toEqual([[1]])

    // reopening A connects again with a new connector
    const a2 = await inProject(projectA, () => Registry.get("store"))
    expect(a2).not.toBe(a)
    expect((await a2.execute("SELECT 1 AS one")).rows).toEqual([[1]])
  })

  test("session-only credentials from warehouse_add survive disposal", async () => {
    // The test preload disables the OS credential store, so the password exists only in memory.
    await inProject(projectA, () => Registry.add("pg", { type: "postgres", host: "h", password: "s3cret-test" } as any))
    await disposeInstance(projectA)
    expect(inProject(projectA, () => Registry.getConfig("pg")?.password)).toBe("s3cret-test")
  })

  test("a connect dropped while its tunnel is opening fails as superseded, with the retry hint", async () => {
    writeLocal(projectA, { store: sshStore("held-dispose") })
    const pending = inProject(projectA, () => Registry.get("store"))
    await sshConnected("held-dispose")
    await disposeInstance(projectA)
    await expect(pending).rejects.toThrow("reloaded or removed while it was connecting. Retry the request.")
  })
})

describe("remove()", () => {
  test("a failed global file write leaves the project's connection usable", async () => {
    writeGlobal({ g: { type: "sqlite", path: path.join(projectA, "g.sqlite"), create: true } })
    const connector = await inProject(projectA, () => Registry.get("g"))
    const globalDir = path.join(home, ".altimate-code")
    fs.chmodSync(globalDir, 0o500)
    fs.chmodSync(path.join(globalDir, "connections.json"), 0o400)
    try {
      const result = await inProject(projectA, () => Registry.remove("g"))
      expect(result.success).toBe(false)
      expect(inProject(projectA, () => Registry.names())).toContain("g")
      expect(await inProject(projectA, () => Registry.get("g"))).toBe(connector)
    } finally {
      fs.chmodSync(globalDir, 0o700)
      fs.chmodSync(path.join(globalDir, "connections.json"), 0o600)
    }
  })
})

describe("credentials of a removed connection", () => {
  test("are kept for an open project that has never used the warehouse registry", async () => {
    const { setSecretBackendForTests } = await import("../../src/altimate/native/connections/credential-store")
    const store = new Map<string, string>()
    setSecretBackendForTests({
      name: "test",
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
    } as any)
    try {
      writeLocal(projectB, { shared: { type: "postgres", host: "b" } })
      await Instance.provide({ directory: projectB, fn: async () => {} })
      await inProject(projectA, () => Registry.add("shared", { type: "postgres", host: "g", password: "pw-test" } as any))
      expect(store.get("shared/password")).toBe("pw-test")

      expect((await inProject(projectA, () => Registry.remove("shared"))).success).toBe(true)
      expect(store.get("shared/password")).toBe("pw-test")
    } finally {
      await Instance.provide({ directory: projectB, fn: () => Instance.dispose() })
      setSecretBackendForTests(undefined)
    }
  })

  test("are kept while another served project's local config still names the connection", async () => {
    const { setSecretBackendForTests } = await import("../../src/altimate/native/connections/credential-store")
    const store = new Map<string, string>()
    setSecretBackendForTests({
      name: "test",
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
    } as any)
    try {
      writeLocal(projectB, { shared: { type: "postgres", host: "b" } })
      expect(inProject(projectB, () => Registry.names())).toEqual(["shared"])
      await inProject(projectA, () => Registry.add("shared", { type: "postgres", host: "g", password: "pw-test" } as any))
      expect(store.get("shared/password")).toBe("pw-test")

      await inProject(projectA, () => Registry.remove("shared"))
      expect(store.get("shared/password")).toBe("pw-test")

      // with no served project naming it, removal forgets the secret
      fs.rmSync(path.join(projectB, ".altimate-code"), { recursive: true })
      await inProject(projectA, () => Registry.add("shared", { type: "postgres", host: "g", password: "pw-test" } as any))
      await inProject(projectA, () => Registry.remove("shared"))
      expect(store.has("shared/password")).toBe(false)
    } finally {
      setSecretBackendForTests(undefined)
    }
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

  test("a connect in flight across reset() is not cached into the dropped state", async () => {
    writeLocal(projectA, { store: { type: "sqlite", path: "store.sqlite", create: true } })
    const inflight = inProject(projectA, () => Registry.get("store"))
    Registry.reset()
    await expect(inflight).rejects.toThrow("reloaded or removed while it was connecting")
  })

  test("closeAll releases connectors cached under setConfigs after load()", async () => {
    Registry.setConfigs({ mem: { type: "sqlite", path: ":memory:" } })
    const injected = await Registry.get("mem")
    inProject(projectA, () => Registry.load())
    await Registry.closeAll()
    await expect(injected.execute("SELECT 1")).rejects.toThrow()
  })
})
