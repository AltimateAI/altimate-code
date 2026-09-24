import { describe, test, expect, beforeAll } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { dirname, join } from "path"
import { $ } from "bun"

const dist = join(import.meta.dir, "../dist")

describe("build integrity", () => {
  beforeAll(async () => {
    // Rebuild to test the actual build output
    await $`bun run build`.cwd(join(import.meta.dir, ".."))
  })

  test("node_python_bridge.py exists in dist", () => {
    expect(existsSync(join(dist, "node_python_bridge.py"))).toBe(true)
  })

  test("no hardcoded absolute paths in __dirname", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    // Catch both Unix ("/...") and Windows ("C:\\...") hardcoded paths
    expect(code).not.toMatch(/var __dirname\s*=\s*"(?:[A-Za-z]:\\\\|\/)/)
  })

  test("the bridge script resolves relative to the bundle at runtime", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).toContain("fileURLToPath(import.meta.url)")
    expect(code).toContain(`"node_python_bridge.py"`)
  })

  test("node_python_bridge.py in dist is dbt-integration's copy", () => {
    const shipped = join(dirname(require.resolve("@altimateai/dbt-integration")), "node_python_bridge.py")
    expect(readFileSync(join(dist, "node_python_bridge.py"), "utf8")).toBe(readFileSync(shipped, "utf8"))
  })
})
