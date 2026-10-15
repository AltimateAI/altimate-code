import { describe, test, expect } from "bun:test"
import path from "path"

const root = path.resolve(import.meta.dir, "../..")

function gitOutput(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("upstream merge entry-point guards", () => {
  for (const entryPoint of ["merge.ts", "bridge-merge.ts"]) {
    test(`${entryPoint} rejects a major upgrade without changing the repository`, () => {
      const head = gitOutput("rev-parse", "HEAD")
      const status = gitOutput("status", "--porcelain")

      const result = Bun.spawnSync(
        [process.execPath, "run", `script/upstream/${entryPoint}`, "--version", "v2.0.0", "--dry-run"],
        { cwd: root },
      )

      expect(gitOutput("rev-parse", "HEAD")).toBe(head)
      expect(gitOutput("status", "--porcelain")).toBe(status)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout.toString() + result.stderr.toString()).toContain("re-port, not a merge")
    })
  }
})
