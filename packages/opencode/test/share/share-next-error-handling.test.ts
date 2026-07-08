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

describe("ShareNext background error handling", () => {
  test("create catches background fullSync failures", () => {
    const createBody = sliceBetween("export async function create", "function get(")
    const activeLines = createBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))

    expect(createBody).toContain("upstream_fix: catch background full share sync failures")
    expect(createBody).toMatch(/fullSync\(sessionID\)\.catch\(/)
    expect(createBody).toContain('log.error("share full sync failed"')
    expect(activeLines.filter((line) => /fullSync\(sessionID\)/.test(line) && !/\.catch\(/.test(line))).toEqual([])
  })

  test("delayed flush catches background sync failures", () => {
    const syncBody = sliceBetween("async function sync", "export async function remove")

    expect(syncBody).toContain("upstream_fix: catch background share flush failures")
    expect(syncBody).toMatch(/setTimeout\(async\s*\(\)\s*=>\s*{\s*\/\/ altimate_change start — upstream_fix: catch background share flush failures\s*try\s*{/)
    expect(syncBody).toContain('log.error("share flush failed"')
  })
})
