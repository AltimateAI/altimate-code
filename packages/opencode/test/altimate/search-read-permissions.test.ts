// altimate_change start — isolate canonicalisation failures to individual search candidates
import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { readableSearchResults } from "@/altimate/search-read-permissions"
import { Permission } from "@/permission"
import { tmpdir } from "../fixture/fixture"

test("search results omit a looping symlink and retain ordinary files", async () => {
  await using project = await tmpdir()
  const before = path.join(project.path, "before.txt")
  const loop = path.join(project.path, "loop.txt")
  const after = path.join(project.path, "after.txt")
  await Promise.all([before, after].map((file) => Bun.write(file, "needle public")))
  await fs.symlink("loop.txt", loop, "file")
  const permissions = Permission.fromConfig({
    read: { "*": "allow", [path.join(project.path, "private.txt")]: "deny" },
  })

  expect(readableSearchResults([before, loop, after], project.path, permissions)).toEqual({
    allowed: new Set([before, after]),
    patterns: [],
  })
})

test.each(["EACCES", "ENOENT", "ELOOP"])(
  "search results omit a candidate when canonicalisation fails with %s and keep other candidates",
  async (code) => {
    await using project = await tmpdir()
    const before = path.join(project.path, "before.txt")
    const bad = path.join(project.path, "unresolvable.txt")
    const after = path.join(project.path, "after.txt")
    await Promise.all([before, bad, after].map((file) => Bun.write(file, "needle public")))
    const resolve = FSUtil.resolve
    const canonicalise = spyOn(FSUtil, "resolve").mockImplementation((file) => {
      if (file === bad) throw Object.assign(new Error(`Cannot resolve ${file}`), { code })
      return resolve(file)
    })
    try {
      const permissions = Permission.fromConfig({
        read: { "*": "ask", [path.join(project.path, "private.txt")]: "deny" },
      })
      expect(readableSearchResults([before, bad, after], project.path, permissions)).toEqual({
        allowed: new Set([before, after]),
        patterns: ["before.txt", "after.txt"],
      })
      expect(canonicalise).toHaveBeenCalledWith(bad)
      expect(canonicalise).toHaveBeenCalledWith(after)
    } finally {
      canonicalise.mockRestore()
    }
  },
)
// altimate_change end
