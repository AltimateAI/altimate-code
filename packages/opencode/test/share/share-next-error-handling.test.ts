import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
const source = readFileSync(join(repoRoot, "packages", "opencode", "src", "share", "share-next.ts"), "utf-8")

function sliceBetween(startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

// share-next.ts's fork-era imperative `try/catch` / `.catch()` guards around background share
// sync were superseded by upstream's own Effect-native equivalent — Effect.catchCause +
// Effect.forkIn(scope) — which these tests now verify directly (see the "supersedes the fork's
// former imperative ..." comments in share-next.ts next to each site).
describe("ShareNext background error handling", () => {
  test("create catches background full-sync failures", () => {
    const createBody = sliceBetween(
      'const create = Effect.fn("ShareNext.create")',
      'const remove = Effect.fn("ShareNext.remove")',
    )

    expect(createBody).toContain("supersedes the fork's")
    expect(createBody).toContain("full-share-sync-failure-must-not-crash bug")
    expect(createBody).toMatch(/full\(sessionID\)\.pipe\(/)
    expect(createBody).toContain('Effect.logError("share full sync failed"')
    expect(createBody).toContain("Effect.forkIn(s.scope)")
  })

  test("sync schedules a delayed flush that catches background failures", () => {
    const syncBody = sliceBetween("function sync(sessionID: SessionID, data: Data[]) {", "const state: InstanceState")

    expect(syncBody).toContain("supersedes the fork's")
    expect(syncBody).toContain("share-sync-failure-must-not-crash bug")
    expect(syncBody).toMatch(/flush\(sessionID\)\.pipe\(\s*Effect\.delay\(1000\)/)
    expect(syncBody).toContain('Effect.logError("share flush failed"')
    expect(syncBody).toContain("Effect.forkIn(s.scope)")
  })
})
