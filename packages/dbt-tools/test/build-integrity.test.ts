import { describe, test, expect, beforeAll } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { $ } from "bun"

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

  test("the bridge script resolves relative to the bundle at runtime", () => {
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
  // Node from wherever npm installed it. A stand-in `python` records what it is
  // asked to run and answers the CLI's prerequisite checks, so this follows the
  // real startup as far as spawning the bridge, without Python or dbt installed.
  test.skipIf(process.platform === "win32")(
    "the published package starts the bridge script next to its own bundle, from any directory",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dbt-tools-published-"))
      try {
        const installed = join(root, "install", "dbt-tools")
        mkdirSync(join(installed, "bin"), { recursive: true })
        mkdirSync(join(installed, "dist"), { recursive: true })
        cpSync(join(pkg, "bin/altimate-dbt"), join(installed, "bin/altimate-dbt"))
        cpSync(join(dist, "index.js"), join(installed, "dist/index.js"))
        cpSync(join(dist, "node_python_bridge.py"), join(installed, "dist/node_python_bridge.py"))
        writeFileSync(join(installed, "package.json"), JSON.stringify({ type: "module" }))

        const argvLog = join(root, "argv.log")
        const python = join(root, "python")
        writeFileSync(
          python,
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >> '${argvLog}'`,
            'case "$1" in',
            '  --version) echo "Python 3.11.9"; exit 0 ;;',
            '  -c) echo "1.10.0"; exit 0 ;;',
            "esac",
            "exit 3",
          ].join("\n") + "\n",
        )
        chmodSync(python, 0o755)
        const project = join(root, "project")
        mkdirSync(project)
        writeFileSync(join(project, "dbt_project.yml"), "name: p\nversion: '1.0'\nprofile: p\n")
        const home = join(root, "home")
        mkdirSync(join(home, ".altimate-code"), { recursive: true })
        writeFileSync(
          join(home, ".altimate-code", "dbt.json"),
          JSON.stringify({ projectRoot: project, pythonPath: python, dbtIntegration: "corecommand", queryLimit: 500 }),
        )

        await $`node ${join(installed, "bin/altimate-dbt")} info`
          .cwd(root)
          .env({ ...process.env, HOME: home })
          .quiet()
          .nothrow()

        const script = join(installed, "dist", "node_python_bridge.py")
        const runs = readFileSync(argvLog, "utf8").split("\n")
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
