import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { Effect } from "effect"
import * as SetupLock from "@opencode-ai/core/database/setup-lock"
import { tmpdir } from "./fixture/tmpdir"

/** Holds the setup lock from a separate connection, as another process would. The release is idempotent. */
function holdExternally(filename: string) {
  const db = new Database(filename + ".setup-lock", { create: true })
  db.run("BEGIN EXCLUSIVE")
  let released = false
  return () => {
    if (released) return
    released = true
    db.run("ROLLBACK")
    db.close()
  }
}

describe("SetupLock wait notice", () => {
  test("defaults to a 5 second threshold", () => {
    expect(SetupLock.WAIT_NOTICE_MS).toBe(5_000)
  })

  test("names the lock file", () => {
    expect(SetupLock.waitNotice("/data/opencode.db")).toBe(
      "Waiting for another altimate-code process to finish setting up the database (lock: /data/opencode.db.setup-lock)",
    )
  })

  test("acquireSync: no notice when the lock is free", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "free-sync.db")
    const lines: string[] = []
    const release = SetupLock.acquireSync(filename, { noticeAfterMs: 0, notify: (line) => lines.push(line) })
    release()
    expect(lines).toEqual([])
  })

  test("acquireSync: prints one notice after the threshold, then keeps waiting until the timeout", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "held-sync.db")
    const releaseHolder = holdExternally(filename)
    const lines: string[] = []
    const started = Date.now()
    try {
      expect(() =>
        SetupLock.acquireSync(filename, { noticeAfterMs: 50, timeoutMs: 300, notify: (line) => lines.push(line) }),
      ).toThrow(/locked|busy/i)
    } finally {
      releaseHolder()
    }
    // The notice did not end the wait: it continued to the full timeout.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(lines).toEqual([SetupLock.waitNotice(filename)])
  })

  test("hold: no notice when the lock is free", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "free-hold.db")
    const lines: string[] = []
    const result = await Effect.runPromise(
      SetupLock.hold(filename, Effect.succeed("ran"), { noticeAfterMs: 0, notify: (line) => lines.push(line) }),
    )
    expect(result).toBe("ran")
    expect(lines).toEqual([])
  })

  test("hold: prints one notice after the threshold and acquires once the holder releases", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "held-hold.db")
    const releaseHolder = holdExternally(filename)
    const lines: string[] = []
    try {
      const result = await Effect.runPromise(
        SetupLock.hold(filename, Effect.succeed("ran"), {
          noticeAfterMs: 50,
          notify: (line) => {
            lines.push(line)
            releaseHolder()
          },
        }),
      )
      expect(result).toBe("ran")
    } finally {
      releaseHolder()
    }
    expect(lines).toEqual([SetupLock.waitNotice(filename)])
  })

  test("acquireSync: a throwing notify does not abort the wait; only the busy error surfaces", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "throwing-sync.db")
    const releaseHolder = holdExternally(filename)
    let notified = 0
    const started = Date.now()
    try {
      expect(() =>
        SetupLock.acquireSync(filename, {
          noticeAfterMs: 50,
          timeoutMs: 300,
          notify: () => {
            notified++
            throw new Error("stderr closed")
          },
        }),
      ).toThrow(/locked|busy/i)
    } finally {
      releaseHolder()
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(notified).toBe(1)
  })

  test("hold: a throwing notify still acquires once the holder releases", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "throwing-hold.db")
    const releaseHolder = holdExternally(filename)
    let notified = 0
    try {
      const result = await Effect.runPromise(
        SetupLock.hold(filename, Effect.succeed("ran"), {
          noticeAfterMs: 50,
          notify: () => {
            notified++
            releaseHolder()
            throw new Error("stderr closed")
          },
        }),
      )
      expect(result).toBe("ran")
    } finally {
      releaseHolder()
    }
    expect(notified).toBe(1)
  })
})
