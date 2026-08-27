import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { isOwnerStale, withLifecycleLock } from "../../src/local/lock"
import type { LocalPaths } from "../../src/local/paths"

function paths(root: string): LocalPaths {
  return {
    root,
    bin: path.join(root, "bin"),
    models: path.join(root, "models"),
    downloads: path.join(root, "downloads"),
    certificates: path.join(root, "certificates"),
    state: path.join(root, "state.json"),
    pid: path.join(root, "server.pid"),
    log: path.join(root, "server.log"),
    environment: path.join(root, "environment.json"),
    recipes: path.join(root, "recipes.json"),
    recipesMeta: path.join(root, "recipes.meta.json"),
  }
}

async function deadPid() {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

describe("withLifecycleLock", () => {
  test("acquires the lock on a truly fresh install where the root directory does not exist yet", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "fresh", "nested", "root")
    await expect(fs.stat(root)).rejects.toThrow()

    const result = await withLifecycleLock(async () => "done", paths(root))
    expect(result).toBe("done")
    // The lock directory is released after the run.
    await expect(fs.stat(path.join(root, ".lifecycle-lock"))).rejects.toThrow()
  }, 10_000)

  // Acquisition is two steps (mkdir, then write owner.json). A waiter that
  // observes the dir but not yet owner.json must not assume the holder
  // crashed and steal the lock out from under it — it should wait out a
  // short grace window instead.
  test("a waiter does not steal the lock while the holder is still publishing owner.json", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "race")
    const testPaths = paths(root)
    const lockDir = path.join(root, ".lifecycle-lock")
    await fs.mkdir(lockDir, { recursive: true }) // holder has mkdir'd but not yet written owner.json

    let waiterRan = false
    const waiter = withLifecycleLock(async () => {
      waiterRan = true
      return "waiter"
    }, testPaths)

    // Still inside the grace window: the waiter must not have proceeded.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(waiterRan).toBe(false)

    // Holder finishes publishing and releases normally.
    await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), {
      mode: 0o600,
    })
    await fs.rm(lockDir, { recursive: true, force: true })

    expect(await waiter).toBe("waiter")
    expect(waiterRan).toBe(true)
  }, 10_000)

  test("reclaims a lock whose owner.json never appears (holder crashed right after mkdir)", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "crashed")
    const testPaths = paths(root)
    const lockDir = path.join(root, ".lifecycle-lock")
    await fs.mkdir(lockDir, { recursive: true }) // dir exists, owner.json never written — simulates a crash

    const result = await withLifecycleLock(async () => "reclaimed", testPaths)
    expect(result).toBe("reclaimed")
  }, 10_000)
})

describe("isOwnerStale", () => {
  test("treats a missing owner as stale", () => {
    expect(isOwnerStale(undefined, Date.now())).toBe(true)
  })

  test("treats a dead pid as stale regardless of age", () => {
    expect(isOwnerStale({ pid: 999999999, at: Date.now() }, Date.now())).toBe(true)
  })

  test("does not evict a live owner just because it is older than ten minutes", async () => {
    // A model download can legitimately run well past ten minutes; a live
    // lock holder must not be forcibly evicted on age alone.
    const elevenMinutesAgo = Date.now() - 11 * 60_000
    expect(isOwnerStale({ pid: process.pid, at: elevenMinutesAgo }, Date.now())).toBe(false)
  })

  test("still evicts a genuinely dead process's lock even if it exited moments ago", async () => {
    const pid = await deadPid()
    expect(isOwnerStale({ pid, at: Date.now() }, Date.now())).toBe(true)
  })

  test("falls back to evicting an implausibly old lock even if the pid reads as alive", () => {
    // Guards against the OS recycling the recorded pid onto an unrelated
    // live process, which would otherwise wedge the lock forever.
    const wayInThePast = Date.now() - 25 * 60 * 60_000
    expect(isOwnerStale({ pid: process.pid, at: wayInThePast }, Date.now())).toBe(true)
  })
})
