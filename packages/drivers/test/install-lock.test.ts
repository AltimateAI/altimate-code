import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { withInstallLock } from "../src/resolve"

// The managed driver directory is shared by every CLI process on the machine,
// and `installsInFlight` only serialises within one process. Eight CLIs
// starting together each ran `npm install` over the same tree:
//
//   npm install failed (exit 217) … ENOTEMPTY …
//     rmdir /root/.local/share/altimate-code/drivers/node_modules/duckdb/…
//
// The exclusion claim is about separate processes, so the central test spawns
// separate processes. An in-process test cannot establish it.

const resolveModule = fileURLToPath(new URL("../src/resolve.ts", import.meta.url))

let dir = ""

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-lock-"))
})

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(`${dir}.lock`, { recursive: true, force: true })
})

describe("cross-process install lock", () => {
  test("excludes concurrent processes from the critical section", async () => {
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    const log = path.join(dir, "log.txt")

    // Each child holds the lock briefly and brackets its critical section.
    // Overlapping brackets in the log mean the lock did not hold.
    const child = path.join(dir, "child.ts")
    fs.writeFileSync(
      child,
      `import fs from "node:fs"
import { withInstallLock } from ${JSON.stringify(resolveModule)}
const [target, log, id] = process.argv.slice(2)
await withInstallLock(target, async (acquired) => {
  if (!acquired) { fs.appendFileSync(log, \`timeout \${id}\\n\`); return }
  fs.appendFileSync(log, \`enter \${id}\\n\`)
  await new Promise((r) => setTimeout(r, 120))
  fs.appendFileSync(log, \`exit \${id}\\n\`)
}, { timeoutMs: 30000 })
process.exit(0)
`,
    )

    const kids = Array.from({ length: 4 }, (_, i) =>
      Bun.spawn(["bun", child, target, log, String(i)], { stdout: "ignore", stderr: "ignore" }),
    )
    const codes = await Promise.all(kids.map((k) => k.exited))
    expect(codes).toEqual([0, 0, 0, 0])

    const events = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    expect(events).not.toContain("timeout 0")
    // Every enter must be followed by its own exit before the next enter.
    let inside: string | undefined
    for (const line of events) {
      const [kind, id] = line.split(" ")
      if (kind === "enter") {
        expect(inside).toBeUndefined()
        inside = id
      } else if (kind === "exit") {
        expect(inside).toBe(id)
        inside = undefined
      }
    }
    expect(events.filter((e) => e.startsWith("enter")).length).toBe(4)
  }, 60_000)

  test("reports the section ran unlocked when the lock cannot be taken in time", async () => {
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    // Hold the lock with a live owner so it cannot be judged stale.
    fs.mkdirSync(`${target}.lock`)
    fs.writeFileSync(
      path.join(`${target}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() }),
    )

    let sawAcquired: boolean | undefined
    await withInstallLock(
      target,
      async (acquired) => {
        sawAcquired = acquired
      },
      { timeoutMs: 200, pollMs: 20 },
    )
    // The work still runs — refusing to install because a peer is slow would
    // turn contention into a hard failure — but it knows it was unlocked.
    expect(sawAcquired).toBe(false)
    // A lock we did not take must not be deleted on the way out.
    expect(fs.existsSync(`${target}.lock`)).toBe(true)
  })

  test("breaks a lock whose owner is gone", async () => {
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(`${target}.lock`)
    fs.writeFileSync(
      path.join(`${target}.lock`, "owner.json"),
      // PID 0x7FFFFFFF is not a live process on any platform we run on.
      JSON.stringify({ pid: 0x7fffffff, hostname: os.hostname(), startedAt: Date.now() }),
    )

    let sawAcquired: boolean | undefined
    await withInstallLock(
      target,
      async (acquired) => {
        sawAcquired = acquired
      },
      { timeoutMs: 5000, pollMs: 20 },
    )
    expect(sawAcquired).toBe(true)
  })

  test("breaks a lock that has outlived any plausible install", async () => {
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(`${target}.lock`)
    fs.writeFileSync(
      path.join(`${target}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() - 10 * 60_000 }),
    )

    let sawAcquired: boolean | undefined
    await withInstallLock(
      target,
      async (acquired) => {
        sawAcquired = acquired
      },
      { timeoutMs: 5000, staleAfterMs: 60_000, pollMs: 20 },
    )
    expect(sawAcquired).toBe(true)
  })

  test("releases the lock when the critical section throws", async () => {
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    let thrown = ""
    try {
      await withInstallLock(target, async () => {
        throw new Error("boom")
      })
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e)
    }
    expect(thrown).toBe("boom")
    expect(fs.existsSync(`${target}.lock`)).toBe(false)
  })
})
