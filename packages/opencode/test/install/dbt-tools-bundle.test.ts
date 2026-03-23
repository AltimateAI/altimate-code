import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")
const PUBLISH_SCRIPT = path.join(REPO_ROOT, "packages/opencode/script/publish.ts")
const DBT_TOOLS_DIR = path.join(REPO_ROOT, "packages/dbt-tools")

// ---------------------------------------------------------------------------
// 1. Source dbt-tools uses ESM — if this changes, publish.ts must adapt
// ---------------------------------------------------------------------------

describe("dbt-tools ESM contract", () => {
  test('source package.json declares "type": "module"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DBT_TOOLS_DIR, "package.json"), "utf-8"))
    expect(pkg.type).toBe("module")
  })

  test("bin/altimate-dbt uses node shebang (not bun)", () => {
    const bin = fs.readFileSync(path.join(DBT_TOOLS_DIR, "bin/altimate-dbt"), "utf-8")
    expect(bin).toContain("#!/usr/bin/env node")
  })

  test("bin/altimate-dbt uses ESM import() to load dist/index.js", () => {
    const bin = fs.readFileSync(path.join(DBT_TOOLS_DIR, "bin/altimate-dbt"), "utf-8")
    expect(bin).toContain('import("../dist/index.js")')
  })

  test("build outputs ESM format (--format esm in build script)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DBT_TOOLS_DIR, "package.json"), "utf-8"))
    const buildScript = pkg.scripts?.build || ""
    expect(buildScript).toContain("--format esm")
  })
})

// ---------------------------------------------------------------------------
// 2. publish.ts must bundle a package.json with "type": "module"
// ---------------------------------------------------------------------------

describe("publish.ts dbt-tools ESM bundling", () => {
  const publishSource = fs.readFileSync(PUBLISH_SCRIPT, "utf-8")

  test("copyAssets writes a dbt-tools/package.json", () => {
    // The publish script must create a package.json in the bundled dbt-tools dir.
    // Without it, Node defaults to CJS and `import` statements in dist/index.js fail.
    expect(publishSource).toContain("dbt-tools/package.json")
  })

  test('copyAssets writes package.json with type: "module" via Bun.file', () => {
    // Match the actual write call, not just a comment or string literal.
    expect(publishSource).toContain('Bun.file(`${targetDir}/dbt-tools/package.json`).write')
    expect(publishSource).toContain('JSON.stringify({ type: "module" }')
  })

  test("copyAssets creates dbt-tools/bin and dbt-tools/dist directories", () => {
    expect(publishSource).toContain("dbt-tools/bin")
    expect(publishSource).toContain("dbt-tools/dist")
  })

  test("copyAssets copies the altimate-dbt bin wrapper", () => {
    expect(publishSource).toContain("dbt-tools/bin/altimate-dbt")
  })

  test("copyAssets copies dist/index.js (not the entire dist/ tree)", () => {
    // Copying all of dist/ would include ~220MB of .node native binaries
    expect(publishSource).toContain("dist/index.js")
  })
})

// ---------------------------------------------------------------------------
// 3. Structural: if dbt-tools ever switches away from ESM, tests should catch it
// ---------------------------------------------------------------------------

describe("dbt-tools + Node compatibility", () => {
  test("bin wrapper import path matches dist output location", () => {
    // The bin wrapper does `import("../dist/index.js")`.
    // If the build output location changes, this test forces an update.
    const bin = fs.readFileSync(path.join(DBT_TOOLS_DIR, "bin/altimate-dbt"), "utf-8")
    const match = bin.match(/import\(["']([^"']+)["']\)/)
    expect(match).not.toBeNull()
    const importPath = match![1]
    expect(importPath).toBe("../dist/index.js")
  })

  test("Node would fail without package.json type:module (regression guard)", () => {
    // This is the exact scenario that caused the bug:
    // - bin/altimate-dbt has `#!/usr/bin/env node`
    // - It uses `import("../dist/index.js")`
    // - dist/index.js starts with `import { createRequire } from "node:module"`
    // - Without "type": "module" in package.json, Node treats .js as CJS
    // - CJS cannot use top-level `import` → SyntaxError
    //
    // This test verifies the chain of conditions that require package.json:
    const bin = fs.readFileSync(path.join(DBT_TOOLS_DIR, "bin/altimate-dbt"), "utf-8")

    // Assert prerequisites explicitly so the test cannot pass vacuously
    const usesNode = bin.includes("#!/usr/bin/env node")
    const usesESMImport = bin.includes("import(")
    expect(usesNode).toBe(true)
    expect(usesESMImport).toBe(true)

    // Given both conditions hold, package.json MUST have "type": "module"
    const pkg = JSON.parse(fs.readFileSync(path.join(DBT_TOOLS_DIR, "package.json"), "utf-8"))
    expect(pkg.type).toBe("module")

    // AND publish.ts MUST bundle that information via Bun.file().write()
    const publishSource = fs.readFileSync(PUBLISH_SCRIPT, "utf-8")
    expect(publishSource).toContain('JSON.stringify({ type: "module" }')
  })

  test("all dbt-tools bin entries use node shebang (consistency check)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DBT_TOOLS_DIR, "package.json"), "utf-8"))
    const binEntries: Record<string, string> = pkg.bin || {}

    for (const [name, relPath] of Object.entries(binEntries)) {
      const binPath = path.join(DBT_TOOLS_DIR, relPath)
      expect(fs.existsSync(binPath)).toBe(true)

      const content = fs.readFileSync(binPath, "utf-8")
      // All bin entries should use node (not bun) since end users may not have bun
      expect(content).toContain("#!/usr/bin/env node")
    }
  })
})
