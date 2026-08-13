import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

// altimate_change start — upstream_fix: legacy `/find` search must survive unusable records.
// `search()` used to `JSON.parse` + strictly `Result.parse` every line, so a single unusable record
// threw out of the whole call and discarded every match already collected from unrelated files —
// the same defect fixed in packages/core/src/ripgrep.ts. This path is reachable from the mounted
// `/find` route (server/routes/file.ts), so it needs its own coverage.
const withRepo = async (run: (dir: string) => Promise<void>) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rg-")))
  try {
    await run(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe("legacy Ripgrep.search", () => {
  test("returns matches from a file whose matched line is not valid UTF-8", () =>
    withRepo(async (dir) => {
      await fs.writeFile(path.join(dir, "a-plain.txt"), "needle here\n")
      // ripgrep emits `{"bytes": "<base64>"}` rather than `{"text": ...}` for this line, which the
      // strict Zod schema rejected — taking the unrelated matches down with it.
      await fs.writeFile(path.join(dir, "b-binary.txt"), Buffer.from("needle \xff\xfe tail\n", "binary"))
      await fs.writeFile(path.join(dir, "c-plain.txt"), "needle here\n")

      const matches = await Ripgrep.search({ cwd: dir, pattern: "needle", limit: 10 })

      expect(matches.map((match) => match.path.text.replace(/^\.\//, "")).sort()).toEqual([
        "a-plain.txt",
        "b-binary.txt",
        "c-plain.txt",
      ])
      const binary = matches.find((match) => match.path.text.includes("b-binary.txt"))
      expect(binary?.lines.text).toContain("needle")
      expect(binary?.lines.text).toContain("tail")
    }))
})
// altimate_change end
