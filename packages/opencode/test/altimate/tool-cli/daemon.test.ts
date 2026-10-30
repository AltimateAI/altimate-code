import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, symlinkSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  socketName,
  socketPath,
  runViaDaemon,
  selfCommand,
  send,
  startDaemon,
  type Daemon,
} from "../../../src/altimate/tool-cli/daemon"
import type { Runner } from "../../../src/altimate/tool-cli/runner"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "tcd-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function fakeRunner(): Runner & { closed: boolean; calls: unknown[] } {
  const state = {
    closed: false,
    calls: [] as unknown[],
    async list() {
      return []
    },
    async run(name: string, args: unknown, options?: { allowWrite?: boolean }) {
      state.calls.push({ name, args, allowWrite: options?.allowWrite })
      if (name === "fail") return { status: "error" as const, title: "t", output: "boom", metadata: {} }
      return { status: "ok" as const, title: `ran ${name}`, output: JSON.stringify(args), metadata: { allowWrite: options?.allowWrite === true } }
    },
    async close() {
      state.closed = true
    },
  }
  return state
}

async function start(idleMs = 60_000) {
  const dir = await temp()
  const file = path.join(dir, "d.sock")
  const runner = fakeRunner()
  const daemon = await startDaemon({ directory: dir, version: "9.9.9", runner, file, idleMs })
  cleanups.push(() => daemon.stop())
  return { dir, file, runner, daemon }
}

describe("socket naming", () => {
  test("depends on directory and version", async () => {
    const dir = await temp()
    const other = await temp()
    expect(socketName(dir, "1.0.0")).toBe(socketName(dir, "1.0.0"))
    expect(socketName(dir, "1.0.0")).not.toBe(socketName(dir, "1.0.1"))
    // An explicit connections file gets its own daemon, never the project's default one.
    expect(socketName(dir, "1.0.0", "a.json")).not.toBe(socketName(dir, "1.0.0"))
    expect(socketName(dir, "1.0.0", "a.json")).not.toBe(socketName(dir, "1.0.0", "b.json"))
    expect(socketName(dir, "1.0.0")).not.toBe(socketName(other, "1.0.0"))
    expect(socketPath(dir, "1.0.0")).not.toBe(socketPath(dir, "1.0.1"))
    expect(socketPath(dir, "1.0.0", "/x")).toBe(`/x/${socketName(dir, "1.0.0")}.sock`)
  })

  test("selfCommand starts with the current executable", () => {
    expect(selfCommand()[0]).toBe(process.execPath)
  })
})

describe("daemon round trip", () => {
  test("runs a tool and honours allowWrite per request", async () => {
    const { file, runner } = await start()
    const readOnly = await send(file, { id: "1", name: "sql_format", args: { sql: "select 1" }, allowWrite: false })
    expect(readOnly).toMatchObject({ id: "1", status: "ok", title: "ran sql_format", output: '{"sql":"select 1"}' })
    const write = await send(file, { id: "2", name: "sql_format", args: {}, allowWrite: true })
    expect(write?.metadata).toEqual({ allowWrite: true })
    expect(runner.calls).toEqual([
      { name: "sql_format", args: { sql: "select 1" }, allowWrite: false },
      { name: "sql_format", args: {}, allowWrite: true },
    ])
  })

  test("tool errors and malformed requests come back as error responses", async () => {
    const { file } = await start()
    expect((await send(file, { id: "1", name: "fail" }))?.status).toBe("error")
    expect((await send(file, { id: "2" }))?.status).toBe("error")
  })

  test("serves concurrent clients", async () => {
    const { file } = await start()
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) => send(file, { id: String(index), name: "t", args: { index } })),
    )
    expect(replies.map((reply) => reply?.id)).toEqual(Array.from({ length: 8 }, (_, index) => String(index)))
  })

  test("status reports the daemon and stop shuts it down and removes the socket", async () => {
    const { file, daemon, runner, dir } = await start()
    const status = await send(file, { id: "s", op: "status" })
    expect(status?.metadata).toMatchObject({ pid: process.pid, version: "9.9.9", requests: 0 })
    expect(status?.metadata.directory).toBeString()
    expect(dir.length).toBeGreaterThan(0)
    await send(file, { id: "x", op: "stop" })
    await daemon.closed
    expect(runner.closed).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(await send(file, { id: "y", op: "status" })).toBeUndefined()
  })
})

describe("connection env in the socket name", () => {
  test("changes the name only when ALTIMATE_CODE_CONN_* variables exist", async () => {
    const dir = await temp()
    const none = socketName(dir, "1.0.0", undefined, undefined, { PATH: "/bin" })
    expect(none).toBe(socketName(dir, "1.0.0"))
    const a = socketName(dir, "1.0.0", undefined, undefined, { ALTIMATE_CODE_CONN_A: '{"type":"duckdb"}' })
    const b = socketName(dir, "1.0.0", undefined, undefined, { ALTIMATE_CODE_CONN_A: '{"type":"sqlite"}' })
    expect(a).not.toBe(none)
    expect(a).not.toBe(b)
    expect(socketName(dir, "1.0.0", undefined, undefined, { ALTIMATE_CODE_CONN_B: "1", ALTIMATE_CODE_CONN_A: "2" })).toBe(
      socketName(dir, "1.0.0", undefined, undefined, { ALTIMATE_CODE_CONN_A: "2", ALTIMATE_CODE_CONN_B: "1" }),
    )
    expect(socketPath(dir, "1.0.0", "/x", undefined, undefined, { ALTIMATE_CODE_CONN_A: "1" })).toBe(
      `/x/${socketName(dir, "1.0.0", undefined, undefined, { ALTIMATE_CODE_CONN_A: "1" })}.sock`,
    )
  })

  test("uses the registry's prefix", async () => {
    const { CONN_ENV_PREFIX } = await import("../../../src/altimate/native/connections/registry")
    const dir = await temp()
    expect(socketName(dir, "1", undefined, undefined, { [`${CONN_ENV_PREFIX}X`]: "1" })).not.toBe(socketName(dir, "1"))
  })
})

describe("connection refresh", () => {
  test("runs before each run request and a failure is reported", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    const runner = fakeRunner()
    let refreshes = 0
    let fail = false
    const daemon = await startDaemon({
      directory: dir,
      version: "1",
      runner,
      file,
      idleMs: 60_000,
      refreshConnections: async () => {
        refreshes++
        if (fail) throw new Error("bad connections file")
      },
    })
    cleanups.push(() => daemon.stop())
    expect((await send(file, { id: "1", name: "t" }))?.status).toBe("ok")
    expect(refreshes).toBe(1)
    await send(file, { id: "2", op: "status" })
    expect(refreshes).toBe(1)
    fail = true
    const reply = await send(file, { id: "3", name: "t" })
    expect(reply).toMatchObject({ status: "error", output: "bad connections file" })
  })
})

describe("connection refresh serialization", () => {
  test("skips the connections check while another request is already in flight", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    const gates: Array<() => void> = []
    const runner = fakeRunner()
    runner.run = () =>
      new Promise((resolve) => gates.push(() => resolve({ status: "ok" as const, title: "t", output: "", metadata: {} })))
    let refreshes = 0
    const daemon = await startDaemon({
      directory: dir,
      version: "1",
      runner,
      file,
      idleMs: 60_000,
      refreshConnections: async () => void refreshes++,
    })
    cleanups.push(() => daemon.stop())
    const first = send(file, { id: "1", name: "t" })
    while (gates.length < 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(refreshes).toBe(1)
    const second = send(file, { id: "2", name: "t" })
    while (gates.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    // The second request arrived while the first was still in flight: its own reload is skipped, since a reload
    // would close connectors the first request may still be using.
    expect(refreshes).toBe(1)
    gates[0]()
    await first
    gates[1]()
    await second
  })

  test("a request that arrives during a reload waits for it before running", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    const events: string[] = []
    const runner = fakeRunner()
    runner.run = async (name) => {
      events.push(`run ${name}`)
      return { status: "ok" as const, title: "t", output: "", metadata: {} }
    }
    let finishReload!: () => void
    let reloads = 0
    const daemon = await startDaemon({
      directory: dir,
      version: "1",
      runner,
      file,
      idleMs: 60_000,
      refreshConnections: () => {
        if (++reloads > 1) return Promise.resolve()
        events.push("reload start")
        return new Promise<void>((resolve) => (finishReload = () => (events.push("reload end"), resolve())))
      },
    })
    cleanups.push(() => daemon.stop())
    const first = send(file, { id: "1", name: "a" })
    while (!finishReload) await new Promise((resolve) => setTimeout(resolve, 10))
    const second = send(file, { id: "2", name: "b" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events).toEqual(["reload start"])
    finishReload()
    await Promise.all([first, second])
    expect(events.slice(0, 2)).toEqual(["reload start", "reload end"])
    expect(events.slice(2).sort()).toEqual(["run a", "run b"])
  })
})

describe("file lock release", () => {
  test("releases once after concurrent requests finish, never while one is in flight", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    const gates: Array<() => void> = []
    const runner = fakeRunner()
    runner.run = () =>
      new Promise((resolve) => gates.push(() => resolve({ status: "ok" as const, title: "t", output: "", metadata: {} })))
    let releases = 0
    const daemon = await startDaemon({ directory: dir, version: "1", runner, file, idleMs: 60_000, releaseFiles: async () => void releases++ })
    cleanups.push(() => daemon.stop())
    const replies = [send(file, { id: "1", name: "t" }), send(file, { id: "2", name: "t" })]
    while (gates.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    gates[0]()
    await replies[0]
    expect(releases).toBe(0)
    gates[1]()
    await replies[1]
    expect(releases).toBeGreaterThanOrEqual(1)
  })
})

describe("idle shutdown", () => {
  test("exits after the idle timeout and removes its socket", async () => {
    const { file, daemon, runner } = await start(150)
    expect(existsSync(file)).toBe(true)
    await daemon.closed
    expect(runner.closed).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  test("activity postpones the idle exit", async () => {
    const { file, daemon } = await start(300)
    let stopped = false
    void daemon.closed.then(() => (stopped = true))
    for (let index = 0; index < 4; index++) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect((await send(file, { id: String(index), name: "t" }))?.status).toBe("ok")
    }
    expect(stopped).toBe(false)
    await daemon.closed
  })
})

describe("stale and contested sockets", () => {
  async function staleSocket(file: string) {
    // A socket file whose listener is gone, as a crashed daemon leaves behind.
    const script = `const net=require("net");net.createServer().listen(process.argv[1],()=>process.kill(process.pid,"SIGKILL"))`
    const child = Bun.spawn([process.execPath, "-e", script, file], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    expect(existsSync(file)).toBe(true)
  }

  test("a client treats a stale socket as no daemon and leaves it alone", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    await staleSocket(file)
    expect(await send(file, { id: "1", name: "t" })).toBeUndefined()
    expect(existsSync(file)).toBe(true)
  })

  test("a held fresh lock makes a second daemon report a lost race", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    mkdirSync(`${file}.lock`)
    await expect(startDaemon({ directory: dir, version: "1", runner: fakeRunner(), file })).rejects.toThrow("already running")
    expect(existsSync(`${file}.lock`)).toBe(true)
  })

  test("the lock is removed once the daemon is listening", async () => {
    const { file } = await start()
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  test("refuses a socket directory that is a symlink", async () => {
    const dir = await temp()
    const real = path.join(dir, "real")
    mkdirSync(real)
    const link = path.join(dir, "link")
    symlinkSync(real, link)
    await expect(
      startDaemon({ directory: dir, version: "1", runner: fakeRunner(), file: path.join(link, "d.sock") }),
    ).rejects.toThrow("symlink")
  })

  test("a new daemon replaces a stale socket", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    await staleSocket(file)
    const daemon = await startDaemon({ directory: dir, version: "1", runner: fakeRunner(), file, idleMs: 60_000 })
    cleanups.push(() => daemon.stop())
    expect((await send(file, { id: "1", name: "t" }))?.status).toBe("ok")
  })

  test("a second daemon refuses to take over a live socket", async () => {
    const { dir, file } = await start()
    await expect(startDaemon({ directory: dir, version: "9.9.9", runner: fakeRunner(), file })).rejects.toThrow(
      "already running",
    )
    expect((await send(file, { id: "1", name: "t" }))?.status).toBe("ok")
  })
})

describe("runViaDaemon", () => {
  test("spawns a daemon when none is listening, then reuses it", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    const runner = fakeRunner()
    let spawned = 0
    let daemon: Daemon | undefined
    const spawn = () => {
      spawned++
      void startDaemon({ directory: dir, version: "1", runner, file, idleMs: 60_000 }).then((started) => (daemon = started))
    }
    cleanups.push(async () => void (await daemon?.stop()))
    const first = await runViaDaemon(dir, "1", { id: "1", name: "t", args: {} }, { file, spawn })
    expect(first?.status).toBe("ok")
    const second = await runViaDaemon(dir, "1", { id: "2", name: "t", args: {} }, { file, spawn })
    expect(second?.status).toBe("ok")
    expect(spawned).toBe(1)
  })

  test("returns undefined when the daemon never comes up", async () => {
    const dir = await temp()
    const file = path.join(dir, "never.sock")
    const reply = await runViaDaemon(dir, "1", { id: "1", name: "t" }, { file, spawn: () => {}, waitMs: 200 })
    expect(reply).toBeUndefined()
  })

  test("a connection that drops mid-request is an error, not a silent re-run", async () => {
    const dir = await temp()
    const file = path.join(dir, "drop.sock")
    const server = net.createServer((socket) => socket.once("data", () => socket.destroy()))
    await new Promise<void>((resolve) => server.listen(file, resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    await expect(runViaDaemon(dir, "1", { id: "1", name: "t" }, { file, spawn: () => {} })).rejects.toThrow()
  })
})
