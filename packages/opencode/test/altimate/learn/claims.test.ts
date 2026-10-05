// altimate_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { batchID, claimsDirectory, createClaimManager } from "../../../src/altimate/learn/claims"
import { reflectSessionSignals } from "../../../src/altimate/learn/session-reflect"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import * as Playbook from "../../../src/altimate/learn/playbook"

const name = Playbook.DEFAULT_NAME
const sessionID = "ses_claims"
const source = async () => ({ prompts: [], calls: [] })
const owner = (pid: number, now = Date.now) => createClaimManager({ pid, host: "test-host", now, isAlive: () => true })
const seed = async (root: string, text = "Use explicit result columns.") => (await Signals.appendSignal(root, {
  kind: "review", sessionID, text, reason: "review",
}))!

describe("reflection batch claims", () => {
  test("batch identity is deterministic, scoped by store and insensitive to signal order", () => {
    expect(batchID(name, ["b", "a", "a"])).toBe(batchID(name, ["a", "b"]))
    expect(batchID(name, ["a"])).not.toBe(batchID("other", ["a"]))
  })

  test("two processes exclude overlapping hashes and one process excludes different batches", async () => {
    await using dir = await tmpdir()
    const a = await seed(dir.path)
    const b = await seed(dir.path, "Use UTC for event timestamps.")
    const first = owner(101)
    const second = owner(102)
    const lease = await first.acquire(dir.path, name, [a.id])
    expect(lease).toBeDefined()
    try {
      expect(await second.acquire(dir.path, name, [a.id, b.id])).toBeUndefined()
      expect(await first.acquire(dir.path, name, [b.id])).toBeUndefined()
      const unrelated = await second.acquire(dir.path, name, [b.id])
      expect(unrelated).toBeDefined()
      await unrelated!.release()
      const files = await fs.readdir(claimsDirectory(dir.path))
      expect(files).toEqual([`${batchID(name, [a.id])}.json`])
      const claim = JSON.parse(await fs.readFile(`${claimsDirectory(dir.path)}/${files[0]}`, "utf8"))
      expect(claim).toMatchObject({ pid: 101, host: "test-host", signalIDs: [a.id] })
      expect(claim.expires).toBeGreaterThan(Date.now())
    } finally {
      await lease!.release()
    }
    expect(await fs.readdir(claimsDirectory(dir.path))).toEqual([])
  })

  test("expired claims are reclaimable and an old owner cannot release its successor", async () => {
    await using dir = await tmpdir()
    const signal = await seed(dir.path)
    let now = 10_000
    const first = createClaimManager({ pid: 101, host: "test-host", now: () => now, ttlMs: 1_000, isAlive: () => true })
    const second = createClaimManager({ pid: 102, host: "test-host", now: () => now, ttlMs: 1_000, isAlive: () => true })
    const initial = await first.acquire(dir.path, name, [signal.id])
    now += 1_001
    const successor = await second.acquire(dir.path, name, [signal.id])
    expect(successor).toBeDefined()
    try {
      await expect(initial!.assert()).rejects.toThrow("expired or was replaced")
      await initial!.release()
      await successor!.assert()
      expect(await fs.readdir(claimsDirectory(dir.path))).toHaveLength(1)
    } finally {
      await initial!.release()
      await successor!.release()
    }
  })

  test("a known dead local owner is recoverable before expiry, remote ownership waits for expiry", async () => {
    await using dir = await tmpdir()
    const signal = await seed(dir.path)
    const first = owner(101)
    const initial = await first.acquire(dir.path, name, [signal.id])
    const remote = createClaimManager({ pid: 102, host: "other-host", isAlive: () => false })
    const local = createClaimManager({ pid: 102, host: "test-host", isAlive: () => false })
    try {
      expect(await remote.acquire(dir.path, name, [signal.id])).toBeUndefined()
      const recovered = await local.acquire(dir.path, name, [signal.id])
      expect(recovered).toBeDefined()
      await recovered!.release()
    } finally {
      await initial!.release()
    }
  })

  test("a consumed batch cannot be claimed from a stale reader", async () => {
    await using dir = await tmpdir()
    const signal = await seed(dir.path)
    await Signals.consumeSignals(dir.path, [signal.id], "another-reflection")
    expect(await owner(101).acquire(dir.path, name, [signal.id])).toBeUndefined()
  })
})

describe("claimed session reflection", () => {
  test("two simulated processes make only one model call for overlapping batches", async () => {
    await using dir = await tmpdir()
    await seed(dir.path)
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const base = { root: dir.path, name, sessionID, loadSource: source }
    const firstOwner = owner(101)
    const secondOwner = owner(102)
    let calls = 0
    const first = reflectSessionSignals({
      ...base, claimManager: firstOwner,
      getGenerate: async () => async () => {
        calls++
        started.resolve()
        await resume.promise
        return { deltas: [] }
      },
    })
    await started.promise
    await seed(dir.path, "Keep timestamp conversion in UTC.")
    try {
      expect(await reflectSessionSignals({
        ...base, claimManager: secondOwner,
        getGenerate: async () => { throw new Error("Must claim before resolving a model") },
      })).toEqual({ status: "none" })
    } finally {
      resume.resolve()
    }
    expect((await first).status).toBe("done")
    expect(calls).toBe(1)
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
    expect((await reflectSessionSignals({
      ...base, claimManager: secondOwner,
      getGenerate: async () => async () => { calls++; return { deltas: [] } },
    })).status).toBe("done")
    expect(calls).toBe(2)
    expect(await Signals.listSignals(dir.path)).toEqual([])
  })

  test("model failure releases the claim for another process without consuming feedback", async () => {
    await using dir = await tmpdir()
    await seed(dir.path)
    const base = { root: dir.path, name, sessionID, loadSource: source }
    await expect(reflectSessionSignals({
      ...base, claimManager: owner(101),
      getGenerate: async () => async () => { throw new Error("offline") },
    })).rejects.toThrow("offline")
    expect(await fs.readdir(claimsDirectory(dir.path))).toEqual([])
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
    expect((await reflectSessionSignals({
      ...base, claimManager: owner(102), getGenerate: async () => async () => ({ deltas: [] }),
    })).status).toBe("done")
  })

  test("losing a lease during the model call prevents publishing or consuming feedback", async () => {
    await using dir = await tmpdir()
    const signal = await seed(dir.path)
    let now = 1_000
    const first = createClaimManager({ pid: 101, host: "test-host", now: () => now, ttlMs: 1_000, isAlive: () => true })
    const second = createClaimManager({ pid: 102, host: "test-host", now: () => now, ttlMs: 1_000, isAlive: () => true })
    let successor: Awaited<ReturnType<typeof second.acquire>>
    try {
      await expect(reflectSessionSignals({
        root: dir.path, name, sessionID, loadSource: source, claimManager: first,
        getGenerate: async () => async () => {
          now += 1_001
          successor = await second.acquire(dir.path, name, [signal.id])
          return { deltas: [{ op: "ADD", text: "Use UTC for timestamps.", reason: "review" }] }
        },
      })).rejects.toThrow("expired or was replaced")
      expect(successor).toBeDefined()
      expect(await Store.readCandidate(dir.path, name)).toBeUndefined()
      expect(await Signals.listSignals(dir.path)).toHaveLength(1)
      await successor!.assert()
    } finally {
      await successor?.release()
    }
  })

  test("cancellation after source loading avoids resolving the model and releases the claim", async () => {
    await using dir = await tmpdir()
    await seed(dir.path)
    let running = true
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID,
      shouldContinue: () => running,
      loadSource: async () => { running = false; return source() },
      getGenerate: async () => { throw new Error("Do not resolve a model after shutdown") },
    })
    expect(result).toEqual({ status: "none" })
    expect(await fs.readdir(claimsDirectory(dir.path))).toEqual([])
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  })

  for (const phase of ["resolve", "generate"] as const) {
    test(`disposal in the last guard microtask cannot ${phase} a model`, async () => {
      await using dir = await tmpdir()
      await seed(dir.path)
      let running = true
      let boundary = false
      let queued = false
      let resolved = 0
      let calls = 0
      const result = await reflectSessionSignals({
        root: dir.path, name, sessionID,
        shouldContinue: () => {
          if (boundary && !queued) {
            queued = true
            queueMicrotask(() => { running = false })
          }
          return running
        },
        loadSource: async () => { boundary = phase === "resolve"; return source() },
        getGenerate: async () => {
          resolved++
          boundary = true
          return async () => { calls++; return { deltas: [] } }
        },
      })
      expect(result).toEqual({ status: "none" })
      expect(resolved).toBe(phase === "resolve" ? 0 : 1)
      expect(calls).toBe(0)
      expect(await Signals.listSignals(dir.path)).toHaveLength(1)
    })
  }

  test("cancellation after the first model call prevents replacement calls", async () => {
    await using dir = await tmpdir()
    await seed(dir.path)
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
      { id: "L-aaaa", text: "Keep timestamps in local time.", helpful: 0, harmful: 0 },
    ]))
    let running = true
    let calls = 0
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source, shouldContinue: () => running,
      getGenerate: async () => async () => {
        calls++
        running = false
        return { deltas: [{ op: "REMOVE", id: "L-aaaa", reason: "Use UTC instead" }] }
      },
    })
    expect(result).toEqual({ status: "none" })
    expect(calls).toBe(1)
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  })

  test("recovery can restrict reflection to the initial signal snapshot", async () => {
    await using dir = await tmpdir()
    const initial = await seed(dir.path)
    const later = await seed(dir.path, "Do not include this new turn's feedback.")
    const result = await reflectSessionSignals({
      root: dir.path, name, sessionID, loadSource: source, signalIDs: [initial.id],
      getGenerate: async () => async ({ prompt }) => {
        expect(prompt).toContain(initial.text)
        expect(prompt).not.toContain(later.text)
        return { deltas: [] }
      },
    })
    expect(result.status).toBe("done")
    expect(await Signals.listSignals(dir.path)).toEqual([later])
  })
})
