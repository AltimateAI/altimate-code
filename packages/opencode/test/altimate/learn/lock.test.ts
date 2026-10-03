// altimate_change - new file
import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { withLearnLock } from "../../../src/altimate/learn/lock"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"

async function waitFile(file: string) {
  const until = Date.now() + 5000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(5)
  }
}

test("learn transaction keeps every state mutation exclusive across processes while heartbeating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-processes-"))
  const name = "team-playbook"
  const signal = await Signals.appendSignal(root, { kind: "review", sessionID: "first", text: "Check model ownership.", reason: "review" })
  const withLock = Flock.withLock
  const lock = spyOn(Flock, "withLock").mockImplementation((key, task, opts) => withLock(key, task, { ...opts, staleMs: 300 }))
  const dir = path.resolve(import.meta.dir, "../../../src/altimate/learn")
  const child = Bun.spawn([process.execPath, "--eval", `
    import fs from "node:fs/promises";
    import { Flock } from "@opencode-ai/core/util/flock";
    import * as Store from ${JSON.stringify(path.join(dir, "store.ts"))};
    import * as Playbook from ${JSON.stringify(path.join(dir, "playbook.ts"))};
    import * as Signals from ${JSON.stringify(path.join(dir, "signals.ts"))};
    const root = ${JSON.stringify(root)};
    while (!(await Bun.file(root + "/start").exists())) await Bun.sleep(5);
    const original = Flock.withLock;
    Flock.withLock = (key, task, opts) => original(key, task, {
      ...opts, staleMs: 300, baseDelayMs: 10, maxDelayMs: 20,
      onWait: async ({ waited }) => {
        if (waited >= 600) await fs.writeFile(root + "/observed", "still waiting");
      },
    });
    const name = ${JSON.stringify(name)};
    await Store.transaction(root, async () => {
      await Store.saveCandidate(root, name, Playbook.withBullets(Playbook.create({ name }), [
        { id: "L-0001", text: "Document model ownership.", helpful: 0, harmful: 0 },
      ]));
      await Store.writeHarmfulFrom(root, name, { "L-0001": ["feedback"] });
      await Store.writePendingReplacements(root, name, [{ id: "L-0002", text: "Check model naming.", reasons: [], feedback: "Use snake case.", kind: "review", attempts: 0 }]);
      await Store.appendHistory(root, name, { action: "reflect" });
      await Signals.consumeSignals(root, [${JSON.stringify(signal!.id)}], "reflect@child");
    });
    await fs.writeFile(root + "/observed", "finished");
  `], { stdout: "pipe", stderr: "pipe" })
  try {
    await Store.transaction(root, async () => {
      await fs.writeFile(path.join(root, "start"), "go")
      await waitFile(path.join(root, "observed"))
      expect(await fs.readFile(path.join(root, "observed"), "utf8")).toBe("still waiting")
      expect(await Store.readCandidate(root, name)).toBeUndefined()
      expect(await Store.readHarmfulFrom(root, name)).toEqual({})
      expect(await Store.readPendingReplacements(root, name)).toEqual([])
      expect(await Bun.file(Store.paths(root, name).history).exists()).toBe(false)
      expect((await Signals.readSignals(root))[0].status).toBe("open")
      // Nested operations reuse this lock rather than queueing behind the child that is waiting.
      await Store.saveCandidate(root, name, Playbook.create({ name }))
    })
    expect(await child.exited).toBe(0)
    expect(await Store.readCandidate(root, name)).toContain("Document model ownership.")
    expect(await Store.readHarmfulFrom(root, name)).toEqual({ "L-0001": ["feedback"] })
    expect(await Store.readPendingReplacements(root, name)).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(Store.paths(root, name).history, "utf8")).action).toBe("reflect")
    expect((await Signals.readSignals(root))[0].status).toBe("consumed")
  } finally {
    lock.mockRestore()
    child.kill()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 15000)

test("learn transaction recovers an abandoned stale cross-process lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-stale-"))
  const dir = path.join(root, ".altimate-code", "learn", Hash.fast("learn-state") + ".lock")
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "heartbeat"), "")
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ token: "abandoned", pid: 2147483647 }))
    const old = new Date(Date.now() - 11 * 60_000)
    await fs.utimes(path.join(dir, "heartbeat"), old, old)
    await Store.transaction(root, async () => Store.saveCandidate(root, "team-playbook", Playbook.create({ name: "team-playbook" })))
    expect(await Store.readCandidate(root, "team-playbook")).toBe("[]\n")
    expect(await fs.stat(dir).catch(() => undefined)).toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("learn transaction immediately recovers a fresh lock whose same-host owner is dead", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-orphan-"))
  const dir = path.join(root, ".altimate-code", "learn", Hash.fast("learn-state") + ".lock")
  const withLock = Flock.withLock
  const lock = spyOn(Flock, "withLock").mockImplementation((key, task, opts) => withLock(key, task, {
    ...opts, timeoutMs: 100, baseDelayMs: 10, maxDelayMs: 20,
  }))
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "heartbeat"), "")
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ token: "abandoned", pid: 2147483647, hostname: os.hostname() }))
    await Store.transaction(root, async () => Store.saveCandidate(root, "team-playbook", Playbook.create({ name: "team-playbook" })))
    expect(await Store.readCandidate(root, "team-playbook")).toBe("[]\n")
    expect(await fs.stat(dir).catch(() => undefined)).toBeUndefined()
  } finally {
    lock.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["live", "foreign", "permission"] as const)("learn does not reclaim a fresh lock with a %s owner", async (owner) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-owner-"))
  const dir = path.join(root, ".altimate-code", "learn", Hash.fast("learn-state") + ".lock")
  const metadata = JSON.stringify({ token: "owned", pid: owner === "live" ? process.pid : 2147483647, hostname: owner === "foreign" ? `${os.hostname()}-other` : os.hostname() })
  const withLock = Flock.withLock
  const lock = spyOn(Flock, "withLock").mockImplementation((key, task, opts) => withLock(key, task, {
    ...opts, timeoutMs: 50, baseDelayMs: 10, maxDelayMs: 20,
  }))
  const kill = owner === "permission" ? spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
  }) : undefined
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "heartbeat"), "")
    await fs.writeFile(path.join(dir, "meta.json"), metadata)
    await expect(Store.transaction(root, async () => undefined)).rejects.toThrow("Timed out waiting for lock")
    expect(await fs.readFile(path.join(dir, "meta.json"), "utf8")).toBe(metadata)
  } finally {
    kill?.mockRestore()
    lock.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("learn lock accepts a short acquisition timeout without running a waiting task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-timeout-"))
  const lease = await Flock.acquire("learn-state", { dir: path.join(root, ".altimate-code", "learn") })
  let entered = false
  try {
    const started = Date.now()
    await expect(withLearnLock(root, async () => { entered = true }, { timeoutMs: 50 })).rejects.toThrow("Timed out waiting for lock")
    expect(Date.now() - started).toBeLessThan(1000)
    expect(entered).toBe(false)
  } finally {
    await lease.release()
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function stealLease(root: string) {
  const dir = path.join(root, ".altimate-code", "learn")
  const heartbeat = path.join(dir, Hash.fast("learn-state") + ".lock", "heartbeat")
  const old = new Date(Date.now() - 11 * 60_000)
  await fs.utimes(heartbeat, old, old)
  return Flock.acquire("learn-state", { dir, staleMs: 10 * 60_000, timeoutMs: 100 })
}

test("learn refuses the original owner's write after another acquirer recovers its stale lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-lost-"))
  const name = "team-playbook"
  const before = Playbook.create({ name })
  await Store.saveCandidate(root, name, before)
  const snapshot = await Store.readCandidate(root, name)
  let replacement: Flock.Lease | undefined
  let writeError: unknown
  try {
    await Store.transaction(root, async () => {
      replacement = await stealLease(root)
      try {
        await Store.saveCandidate(root, name, Playbook.withBullets(before, [
          { id: "L-0001", text: "This stale owner must not write.", helpful: 0, harmful: 0 },
        ]))
      } catch (error) {
        writeError = error
        throw error
      }
    }).catch(() => {}) // The displaced Flock also rejects release; inspect the write itself.
    expect(await Store.readCandidate(root, name)).toBe(snapshot)
    expect(writeError).toBeInstanceOf(Error)
    expect(String(writeError)).toContain("lease lost")
  } finally {
    await replacement?.release()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("learn rechecks the lease between writing a temporary file and publishing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-rename-"))
  const name = "team-playbook"
  const before = Playbook.create({ name })
  await Store.saveCandidate(root, name, before)
  const snapshot = await Store.readCandidate(root, name)
  let replacement: Flock.Lease | undefined
  const write = fs.writeFile.bind(fs)
  const writes = spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    await write(...args)
    if (String(args[0]).startsWith(Store.paths(root, name).candidate + ".") && String(args[0]).endsWith(".tmp")) {
      replacement = await stealLease(root)
    }
  })
  try {
    const error = await Store.saveCandidate(root, name, Playbook.withBullets(before, [
      { id: "L-0001", text: "This stale owner must not publish.", helpful: 0, harmful: 0 },
    ])).then(() => undefined, (error: unknown) => error)
    expect(await Store.readCandidate(root, name)).toBe(snapshot)
    expect(String(error)).toContain("lease lost")
  } finally {
    writes.mockRestore()
    await replacement?.release()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["append", "consume"] as const)("learn refuses signal %s after lease loss during its read", async (operation) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-lock-signal-"))
  const signal = await Signals.appendSignal(root, { kind: "review", sessionID: "old", text: "Check model ownership.", reason: "review" })
  const before = await fs.readFile(Signals.signalsFile(root), "utf8")
  let replacement: Flock.Lease | undefined
  const read = fs.readFile.bind(fs)
  const reads = spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await read(...args)
    if (String(args[0]) === Signals.signalsFile(root) && !replacement) replacement = await stealLease(root)
    return result
  }) as typeof fs.readFile)
  try {
    const pending = operation === "append"
      ? Signals.appendSignal(root, { kind: "review", sessionID: "new", text: "Document model ownership.", reason: "review" })
      : Signals.consumeSignals(root, [signal!.id], "reflect@old")
    const error = await pending.then(() => undefined, (error: unknown) => error)
    expect(await read(Signals.signalsFile(root), "utf8")).toBe(before)
    expect(String(error)).toContain("lease lost")
  } finally {
    reads.mockRestore()
    await replacement?.release()
    await fs.rm(root, { recursive: true, force: true })
  }
})
