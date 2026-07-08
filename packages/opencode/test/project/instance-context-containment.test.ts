import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { containsPath, type InstanceContext } from "../../src/project/instance-context"

// Regression guard for a v1.17.9 MERGE SECURITY REGRESSION. Commit #209 hardened the project-boundary
// check to be symlink-aware (Filesystem.containsReal / realpathSync) to stop symlink-escape attacks
// (CVE-class GHSA-w5fx-fh39-j5rw / CVE-2025-54794). The merge introduced this lexical copy of
// containsPath in instance-context.ts and rewired external-directory.ts (grep/glob/ls + the
// external_directory permission) to it — reverting the protection HERE while Instance.containsPath
// (instance.ts) kept it. The existing security-e2e tests only exercise Instance.containsPath, so the
// regression slipped past CI. These tests exercise THIS copy with a real on-disk symlink.
describe("instance-context.containsPath — symlink-aware project boundary", () => {
  let base = ""
  let project = ""
  let ctx: InstanceContext
  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), "inst-ctx-contain-"))
    project = path.join(base, "project")
    const outside = path.join(base, "outside")
    await fsp.mkdir(project)
    await fsp.mkdir(outside)
    await fsp.writeFile(path.join(outside, "secret.txt"), "OUTSIDE")
    await fsp.writeFile(path.join(project, "inside.txt"), "INSIDE")
    await fsp.symlink(outside, path.join(project, "extlink"), "dir") // in-project symlink -> outside
    ctx = { directory: project, worktree: project, project: {} as InstanceContext["project"] }
  })
  afterAll(async () => {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  })

  test("real in-project paths are contained", () => {
    expect(containsPath(path.join(project, "inside.txt"), ctx)).toBe(true)
    expect(containsPath(project, ctx)).toBe(true)
  })

  test("absolute paths outside the project are NOT contained", () => {
    expect(containsPath(path.join(base, "outside"), ctx)).toBe(false)
    expect(containsPath("/etc/passwd", ctx)).toBe(false)
  })

  test("an in-project SYMLINK pointing outside is NOT contained (the regression)", () => {
    // Lexically inside (project/extlink) but resolves outside — a lexical contains() returns true here
    // (the bug); containsReal resolves the symlink and returns false.
    expect(containsPath(path.join(project, "extlink"), ctx)).toBe(false)
    expect(containsPath(path.join(project, "extlink", "secret.txt"), ctx)).toBe(false)
  })
})
