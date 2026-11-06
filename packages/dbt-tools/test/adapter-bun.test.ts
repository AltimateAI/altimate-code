import { describe, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { $ } from "bun"
import { standInPython } from "./stand-in-python"

const pkg = join(import.meta.dir, "..")

// The published-package tests run the bundle under Node. The TUI and the compiled
// binary run the adapter under Bun, the runtime the bridge used to fail on, so this
// runs the CLI from source under Bun. HOME is a temp dir from the start, so no
// ~/.dbt/dbt_cloud.yml on this machine picks dbt Cloud mode's variant.
describe.skipIf(process.platform === "win32")("the adapter under Bun", () => {
  const script = join(dirname(require.resolve("@altimateai/dbt-integration")), "node_python_bridge.py")

  // The stand-in fails the bridge run. The dbt Core modes then exit 1 with the bridge's
  // report of that exit; `info` in dbt Cloud mode still answers from the project. A
  // failure before the spawn shows its own message in the comparison.
  test.each([
    ["core", { exitCode: 1, output: expect.stringContaining("Python process closed with exit code 3") }],
    ["corecommand", { exitCode: 1, output: expect.stringContaining("Python process closed with exit code 3") }],
    ["cloud", { exitCode: 0 }],
  ])("%s mode spawns the bridge script", async (dbtIntegration, expected) => {
    const root = mkdtempSync(join(tmpdir(), "dbt-tools-bun-"))
    try {
      const { python, runs } = standInPython(root)
      const project = join(root, "project")
      mkdirSync(project)
      writeFileSync(join(project, "dbt_project.yml"), "name: p\nversion: '1.0'\nprofile: p\n")
      const home = join(root, "home")
      mkdirSync(join(home, ".altimate-code"), { recursive: true })
      writeFileSync(
        join(home, ".altimate-code", "dbt.json"),
        JSON.stringify({ projectRoot: project, pythonPath: python, dbtIntegration, queryLimit: 500 }),
      )

      const cli = await $`${process.execPath} ${join(pkg, "src/index.ts")} info`
        .cwd(root)
        .env({ ...process.env, HOME: home })
        .quiet()
        .nothrow()

      expect({ exitCode: cli.exitCode, output: cli.stdout.toString() }).toMatchObject(expected)
      expect(runs()).toContain(script)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
