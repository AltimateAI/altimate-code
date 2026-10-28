import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
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

  test("a client treats a stale socket as no daemon and removes it", async () => {
    const dir = await temp()
    const file = path.join(dir, "d.sock")
    await staleSocket(file)
    expect(await send(file, { id: "1", name: "t" })).toBeUndefined()
    expect(existsSync(file)).toBe(false)
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
