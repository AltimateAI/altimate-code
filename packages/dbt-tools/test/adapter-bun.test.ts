import { describe, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { create } from "../src/adapter"
import { standInPython } from "./stand-in-python"

// The published-package tests run the bundle under Node. The TUI and the compiled
// binary run the adapter under Bun, the runtime the bridge used to fail on, so this
// starts it there.
describe.skipIf(process.platform === "win32")("the adapter under Bun", () => {
  const script = join(dirname(require.resolve("@altimateai/dbt-integration")), "node_python_bridge.py")

  // The stand-in fails the bridge run. The dbt Core modes then reject with the bridge's
  // report of that exit, and dbt Cloud mode resolves anyway. A failure before the
  // spawn rejects with its own message.
  test.each([
    ["core", "rejects"],
    ["corecommand", "rejects"],
    ["cloud", "starts"],
  ])("%s mode spawns the bridge script and %s", async (dbtIntegration, outcome) => {
    const root = mkdtempSync(join(tmpdir(), "dbt-tools-bun-"))
    try {
      const { python, runs } = standInPython(root)
      const project = join(root, "project")
      mkdirSync(project)
      writeFileSync(join(project, "dbt_project.yml"), "name: p\nversion: '1.0'\nprofile: p\n")

      const started = create({ projectRoot: project, pythonPath: python, dbtIntegration, queryLimit: 500 })
      if (outcome === "rejects") {
        await expect(started).rejects.toThrow("Python process closed with exit code 3")
      } else {
        await (await started).dispose()
      }
      expect(runs()).toContain(script)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
