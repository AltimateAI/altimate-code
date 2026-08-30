import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { installLockPath, withInstallLock } from "../src/resolve"

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
    const ready = path.join(dir, "ready")
    fs.mkdirSync(ready)

    // A start barrier, because without one the test can pass vacuously: if the
    // scheduler happens to run the children serially — each acquiring, holding,
    // and exiting before the next starts — the "no overlapping bracket" check
    // is satisfied even by a completely broken lock. Every child announces
    // itself and waits until all four are ready, so they contend for real.
    const child = path.join(dir, "child.ts")
    fs.writeFileSync(
      child,
      `import fs from "node:fs"
import { withInstallLock } from ${JSON.stringify(resolveModule)}
const [target, log, ready, id] = process.argv.slice(2)
fs.writeFileSync(\`\${ready}/\${id}\`, "1")
const deadline = Date.now() + 20000
while (fs.readdirSync(ready).length < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5))
}
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
      Bun.spawn(["bun", child, target, log, ready, String(i)], { stdout: "ignore", stderr: "ignore" }),
    )
    const codes = await Promise.all(kids.map((k) => k.exited))
    expect(codes).toEqual([0, 0, 0, 0])

    const events = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    // All four contended and all four got in; nobody fell through unlocked.
    expect(events.filter((e) => e.startsWith("timeout")).length).toBe(0)
    expect(events.filter((e) => e.startsWith("enter")).length).toBe(4)
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
  }, 60_000)

  test("takes the lock when its parent directory does not exist yet", async () => {
    // The cold-start shape this change exists for. `<dir>.lock` sits beside the
    // managed directory, and on a fresh machine nothing has created the XDG data
    // directory yet — `performInstall` is the first thing that does, and it runs
    // *after* the lock is taken. A non-recursive mkdir would fail ENOENT, take
    // the "cannot lock" branch, and drop every concurrent CLI into an unlocked
    // install: exactly the stampede the lock is meant to stop.
    const target = path.join(dir, "fresh", "xdg", "altimate-code", "drivers")
    expect(fs.existsSync(path.dirname(installLockPath(target)))).toBe(false)

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

  test("breaks a lock left by another host once it has outlived any plausible install", async () => {
    // Age is the only signal available for a lock written by a different host
    // sharing a home directory, because its pid means nothing here.
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(`${target}.lock`)
    fs.writeFileSync(
      path.join(`${target}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, hostname: `${os.hostname()}-other`, startedAt: Date.now() - 10 * 60_000 }),
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

  test("does not age out a live owner on this host", async () => {
    // npm can legitimately run longer than any age we pick — a native build such
    // as oracledb, or a caller that raised its own install timeout. Breaking a
    // live owner's lock would put two npm runs over the same tree, which is the
    // corruption this lock exists to prevent. Where liveness is decidable it is
    // the only thing that counts.
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(`${target}.lock`)
    fs.writeFileSync(
      path.join(`${target}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now() - 60 * 60_000 }),
    )

    let sawAcquired: boolean | undefined
    await withInstallLock(
      target,
      async (acquired) => {
        sawAcquired = acquired
      },
      { timeoutMs: 200, staleAfterMs: 1_000, pollMs: 20 },
    )
    // Waited, then proceeded unlocked rather than stealing a running install.
    expect(sawAcquired).toBe(false)
    expect(fs.existsSync(`${target}.lock`)).toBe(true)
  })

  test("does not delete a lock that has been re-taken by a peer", async () => {
    // A lock we hold can be broken as stale and re-acquired by someone else
    // while our critical section is still running. Releasing by pathname would
    // then delete the successor's live lock and admit a third process, so the
    // release only removes a lock still carrying our own token.
    const target = path.join(dir, "drivers")
    fs.mkdirSync(target, { recursive: true })
    const lockDir = installLockPath(target)

    await withInstallLock(target, async (acquired) => {
      expect(acquired).toBe(true)
      // A peer breaks our lock and takes its own.
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: Date.now(), token: "successor" }),
      )
    })

    expect(fs.existsSync(lockDir)).toBe(true)
    fs.rmSync(lockDir, { recursive: true, force: true })
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
