import { describe, test, expect, beforeAll } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { $ } from "bun"
import { standInPython } from "./stand-in-python"

const pkg = join(import.meta.dir, "..")
const dist = join(pkg, "dist")
const checkout = join(pkg, "../..")

describe("build integrity", () => {
  beforeAll(async () => {
    // Rebuild to test the actual build output
    await $`bun run build`.cwd(pkg)
  })

  test("node_python_bridge.py exists in dist", () => {
    expect(existsSync(join(dist, "node_python_bridge.py"))).toBe(true)
  })

  test("no hardcoded absolute paths in __dirname", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    // Catch both Unix ("/...") and Windows ("C:\\...") hardcoded paths
    expect(code).not.toMatch(/var __dirname\s*=\s*"(?:[A-Za-z]:\\\\|\/)/)
  })

  test("the bundle keeps the references the bridge path is built from at runtime", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).toContain("fileURLToPath(import.meta.url)")
    expect(code).toContain(`"node_python_bridge.py"`)
  })

  test("node_python_bridge.py in dist is dbt-integration's copy", () => {
    const shipped = join(dirname(require.resolve("@altimateai/dbt-integration")), "node_python_bridge.py")
    expect(readFileSync(join(dist, "node_python_bridge.py"), "utf8")).toBe(readFileSync(shipped, "utf8"))
  })

  test("no build-machine path appears anywhere in the bundle", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).not.toContain(checkout)
    // CI runner checkouts on Linux, containers and Windows
    expect(code).not.toContain("/home/runner/work/")
    expect(code).not.toContain("/github/workspace/")
    expect(code).not.toContain("D:\\a\\altimate-code\\")
  })

  test("altimate_python_packages is copied next to the bundle", () => {
    expect(existsSync(join(dist, "altimate_python_packages"))).toBe(true)
  })

  test("__require comes from createRequire, so the bundle runs under Node", () => {
    const code = readFileSync(join(dist, "index.js"), "utf8")
    expect(code).toContain('import { createRequire } from "node:module"')
    expect(code).toMatch(/var __require\s*=.*createRequire\(import\.meta\.url\)/)
  })

  // The published package (see opencode/script/publish.ts copyAssets) is run by
  // Node from wherever npm installed it. With the stand-in `python`, this follows
  // the real startup as far as spawning the bridge, without Python or dbt installed.
  async function startPublished(root: string, dbtIntegration: string) {
    const installed = join(root, "install", "dbt-tools")
    mkdirSync(join(installed, "bin"), { recursive: true })
    mkdirSync(join(installed, "dist"), { recursive: true })
    cpSync(join(pkg, "bin/altimate-dbt"), join(installed, "bin/altimate-dbt"))
    cpSync(join(dist, "index.js"), join(installed, "dist/index.js"))
    cpSync(join(dist, "node_python_bridge.py"), join(installed, "dist/node_python_bridge.py"))
    writeFileSync(join(installed, "package.json"), JSON.stringify({ type: "module" }))

    const { python, runs } = standInPython(root)
    const project = join(root, "project")
    mkdirSync(project)
    writeFileSync(join(project, "dbt_project.yml"), "name: p\nversion: '1.0'\nprofile: p\n")
    // Under Node, HOME is the home directory, so there is no ~/.dbt/dbt_cloud.yml either.
    const home = join(root, "home")
    mkdirSync(join(home, ".altimate-code"), { recursive: true })
    writeFileSync(
      join(home, ".altimate-code", "dbt.json"),
      JSON.stringify({ projectRoot: project, pythonPath: python, dbtIntegration, queryLimit: 500 }),
    )

    const cli = await $`node ${join(installed, "bin/altimate-dbt")} info`
      .cwd(root)
      .env({ ...process.env, HOME: home })
      .quiet()
      .nothrow()

    // Node loads the bundle by its real path; on macOS `tmpdir()` is under the `/var` symlink.
    const script = join(realpathSync(installed), "dist", "node_python_bridge.py")
    return { script, runs: runs(), exitCode: cli.exitCode, output: cli.stdout.toString() }
  }

  // The stand-in `python` is a `#!/bin/sh` script.
  const posixOnly = test.skipIf(process.platform === "win32")

  // A dbt Cloud variant other than fusion-stable, here an unknown one, runs on a dbt Core
  // command engine, which starts the bridge. Without that engine's dependencies it throws first.
  posixOnly(
    "the published package starts dbt Cloud mode's dbt Core command engine",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dbt-tools-cloud-"))
      try {
        const { script, runs, exitCode, output } = await startPublished(root, "cloud")
        // `info` answers from the project once the engine's bridge has failed. A failure
        // before the spawn exits 1, and the comparison shows the CLI's message.
        expect({ exitCode, output }).toMatchObject({ exitCode: 0 })
        expect(runs).toContain(script)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  posixOnly(
    "the published package starts the bridge script next to its own bundle, from any directory",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dbt-tools-published-"))
      try {
        const { script, runs, exitCode, output } = await startPublished(root, "corecommand")
        // The CLI fails on the stand-in's exit, so after the spawn.
        expect({ exitCode, output }).toMatchObject({
          exitCode: 1,
          output: expect.stringContaining("Python process closed with exit code 3"),
        })
        expect(runs).toContain(script)
        expect(existsSync(script)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  // Last: it rebuilds dist, which the tests above read.
  test("consecutive builds produce an identical bundle", async () => {
    const first = readFileSync(join(dist, "index.js"), "utf8")
    await $`bun run build`.cwd(pkg).quiet()
    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(first)
  })
})
