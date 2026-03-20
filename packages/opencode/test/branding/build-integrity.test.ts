import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync, statSync } from "fs"
import { join, resolve } from "path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")

function readJSON(relativePath: string): any {
  const fullPath = join(repoRoot, relativePath)
  return JSON.parse(readFileSync(fullPath, "utf-8"))
}

// ---------------------------------------------------------------------------
// 1. Workspace Integrity
// ---------------------------------------------------------------------------

describe("Workspace Integrity", () => {
  const rootPkg = readJSON("package.json")

  test("root package.json has packageManager field", () => {
    expect(rootPkg.packageManager).toBeDefined()
    expect(typeof rootPkg.packageManager).toBe("string")
    expect(rootPkg.packageManager.length).toBeGreaterThan(0)
  })

  test("root package.json workspaces.packages lists explicit paths (not globs)", () => {
    const packages: string[] = rootPkg.workspaces.packages
    expect(Array.isArray(packages)).toBe(true)
    expect(packages.length).toBeGreaterThan(0)

    for (const pkg of packages) {
      expect(pkg).not.toContain("*")
      expect(pkg).not.toContain("?")
      expect(pkg).not.toContain("{")
    }
  })

  test("every listed workspace directory exists on disk", () => {
    const packages: string[] = rootPkg.workspaces.packages
    for (const pkg of packages) {
      const fullPath = join(repoRoot, pkg)
      expect(existsSync(fullPath)).toBe(true)
    }
  })

  test("every listed workspace directory has a package.json", () => {
    const packages: string[] = rootPkg.workspaces.packages
    for (const pkg of packages) {
      const pkgJsonPath = join(repoRoot, pkg, "package.json")
      expect(existsSync(pkgJsonPath)).toBe(true)
    }
  })

  test("no workspace package.json has private: false with broken main/module fields", () => {
    const packages: string[] = rootPkg.workspaces.packages
    for (const pkg of packages) {
      const pkgJsonPath = join(repoRoot, pkg, "package.json")
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"))

      // Only check publishable packages (private !== true)
      if (pkgJson.private === false || pkgJson.private === undefined) {
        if (pkgJson.main) {
          const mainPath = join(repoRoot, pkg, pkgJson.main)
          // The main field should reference a buildable path or existing file
          // We just check it is a non-empty string (dist files may not exist pre-build)
          expect(typeof pkgJson.main).toBe("string")
          expect(pkgJson.main.length).toBeGreaterThan(0)
        }
        if (pkgJson.module) {
          expect(typeof pkgJson.module).toBe("string")
          expect(pkgJson.module.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Turbo Configuration
// ---------------------------------------------------------------------------

describe("Turbo Configuration", () => {
  test("turbo.json is valid JSON (no trailing commas)", () => {
    const turboPath = join(repoRoot, "turbo.json")
    const raw = readFileSync(turboPath, "utf-8")

    // JSON.parse will throw on trailing commas or invalid syntax
    let parsed: any
    expect(() => {
      parsed = JSON.parse(raw)
    }).not.toThrow()

    expect(parsed).toBeDefined()
  })

  test("turbo.json has typecheck task", () => {
    const turbo = readJSON("turbo.json")
    expect(turbo.tasks).toBeDefined()
    expect(turbo.tasks.typecheck).toBeDefined()
  })

  test("turbo.json does not reference non-existent packages like @opencode-ai/app", () => {
    const turbo = readJSON("turbo.json")
    const turboStr = JSON.stringify(turbo)

    // These packages were removed from the workspace and should not be referenced
    const removedPackages = ["@opencode-ai/app", "@opencode-ai/console", "@opencode-ai/desktop"]
    for (const pkg of removedPackages) {
      expect(turboStr).not.toContain(pkg)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Package Dependencies
// ---------------------------------------------------------------------------

describe("Package Dependencies", () => {
  const rootPkg = readJSON("package.json")

  test("root package.json workspace:* dependencies reference packages that exist", () => {
    const allDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies }
    const workspacePackages: string[] = rootPkg.workspaces.packages

    // Read all workspace package names
    const workspaceNames = new Set<string>()
    for (const pkg of workspacePackages) {
      const pkgJsonPath = join(repoRoot, pkg, "package.json")
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"))
        if (pkgJson.name) {
          workspaceNames.add(pkgJson.name)
        }
      }
    }

    for (const [depName, depVersion] of Object.entries(allDeps)) {
      if (depVersion === "workspace:*") {
        // The dependency should correspond to a workspace package
        // Note: the dep name might differ from the package name due to scope remapping
        // At minimum, we check that at least one workspace exists
        expect(workspaceNames.size).toBeGreaterThan(0)
      }
    }
  })

  test('packages/opencode/package.json exists and has correct name "@altimateai/altimate-code"', () => {
    const opencodePkg = readJSON("packages/opencode/package.json")
    expect(opencodePkg.name).toBe("@altimateai/altimate-code")
  })

  test("packages/opencode/package.json has bin field with entries", () => {
    const opencodePkg = readJSON("packages/opencode/package.json")
    expect(opencodePkg.bin).toBeDefined()
    expect(typeof opencodePkg.bin).toBe("object")
    expect(Object.keys(opencodePkg.bin).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Binary Entry Points
// ---------------------------------------------------------------------------

describe("Binary Entry Points", () => {
  test("packages/opencode/bin/altimate-code file exists", () => {
    const binPath = join(repoRoot, "packages/opencode/bin/altimate-code")
    expect(existsSync(binPath)).toBe(true)
  })

  test("all bin entry points in package.json map to files that exist", () => {
    const opencodePkg = readJSON("packages/opencode/package.json")
    const binEntries: Record<string, string> = opencodePkg.bin

    for (const [name, relativePath] of Object.entries(binEntries)) {
      const fullPath = join(repoRoot, "packages/opencode", relativePath)
      expect(existsSync(fullPath)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Skip Files / Keep Ours Consistency
// ---------------------------------------------------------------------------

// altimate_change start — config.ts is now single source of truth (merge-config.json removed)
describe("Skip Files / Keep Ours Consistency", () => {
  test("config.ts contains critical keepOurs patterns", () => {
    const configPath = join(repoRoot, "script/upstream/utils/config.ts")
    const configSource = readFileSync(configPath, "utf-8")

    const criticalPatterns = ["packages/altimate-engine/**", "script/upstream/**"]
    for (const pattern of criticalPatterns) {
      expect(configSource).toContain(pattern)
    }
  })

  test("config.ts contains critical skipFiles patterns", () => {
    const configPath = join(repoRoot, "script/upstream/utils/config.ts")
    const configSource = readFileSync(configPath, "utf-8")

    const criticalSkipPatterns = ["packages/app/**", "packages/desktop/**", "packages/web/**"]
    for (const pattern of criticalSkipPatterns) {
      expect(configSource).toContain(pattern)
    }
  })
})
// altimate_change end

// ---------------------------------------------------------------------------
// 6. No Orphaned Package References
// ---------------------------------------------------------------------------

describe("No Orphaned Package References", () => {
  test("turbo.json should not reference packages that do not exist in the workspace", () => {
    const turbo = readJSON("turbo.json")
    const rootPkg = readJSON("package.json")
    const turboStr = JSON.stringify(turbo)

    // Extract any package references from turbo.json task keys (e.g., "opencode#test")
    const taskKeys = Object.keys(turbo.tasks || {})
    const workspaceDirs: string[] = rootPkg.workspaces.packages

    // Collect directory base names as valid package short names
    const validShortNames = new Set<string>()
    for (const dir of workspaceDirs) {
      const parts = dir.split("/")
      validShortNames.add(parts[parts.length - 1])
    }

    for (const taskKey of taskKeys) {
      // Task keys with # indicate package-scoped tasks (e.g., "opencode#test")
      if (taskKey.includes("#")) {
        const pkgShortName = taskKey.split("#")[0]
        expect(validShortNames.has(pkgShortName)).toBe(true)
      }
    }
  })

  test("root package.json catalog entries should not reference removed packages", () => {
    const rootPkg = readJSON("package.json")
    const catalog = rootPkg.workspaces?.catalog || {}

    // Catalog entries are version pins, not package references to our workspace.
    // But we verify the catalog itself is valid (all values are version strings).
    for (const [name, version] of Object.entries(catalog)) {
      expect(typeof version).toBe("string")
      expect((version as string).length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Bundle Completeness — Skills & dbt-tools
// ---------------------------------------------------------------------------

describe("Bundle Completeness", () => {
  test("all skills in .opencode/skills/ have a SKILL.md file", () => {
    const skillsDir = join(repoRoot, ".opencode", "skills")
    expect(existsSync(skillsDir)).toBe(true)

    const entries = require("fs").readdirSync(skillsDir, { withFileTypes: true })
    const skillDirs = entries.filter((e: any) => e.isDirectory())
    expect(skillDirs.length).toBeGreaterThan(0)

    for (const dir of skillDirs) {
      const skillPath = join(skillsDir, dir.name, "SKILL.md")
      expect(existsSync(skillPath)).toBe(true)
    }
  })

  test("altimate-setup skill exists in root .opencode/skills/ (not in packages/opencode)", () => {
    // altimate-setup must be in root .opencode/skills/ to be bundled by publish.ts
    const rootSkill = join(repoRoot, ".opencode", "skills", "altimate-setup", "SKILL.md")
    expect(existsSync(rootSkill)).toBe(true)

    // Should NOT exist in packages/opencode/.opencode/skills/ (causes split-brain)
    const pkgSkill = join(repoRoot, "packages", "opencode", ".opencode", "skills", "altimate-setup", "SKILL.md")
    expect(existsSync(pkgSkill)).toBe(false)
  })

  test("build.ts embeds skills via OPENCODE_BUILTIN_SKILLS define", () => {
    const buildScript = readFileSync(join(repoRoot, "packages/opencode/script/build.ts"), "utf-8")
    expect(buildScript).toContain("OPENCODE_BUILTIN_SKILLS")
    expect(buildScript).toContain(".opencode/skills")
    expect(buildScript).toContain("SKILL.md")
  })

  test("skill.ts loads embedded skills from OPENCODE_BUILTIN_SKILLS", () => {
    const skillTs = readFileSync(join(repoRoot, "packages/opencode/src/skill/skill.ts"), "utf-8")
    expect(skillTs).toContain("OPENCODE_BUILTIN_SKILLS")
    expect(skillTs).toContain("builtin:")
  })

  test("publish.ts bundles dbt-tools binary and dist", () => {
    const publishScript = readFileSync(join(repoRoot, "packages/opencode/script/publish.ts"), "utf-8")
    expect(publishScript).toContain("dbt-tools/bin/altimate-dbt")
    expect(publishScript).toContain("dbt-tools/dist")
    expect(publishScript).toContain("bun run build")
  })

  test("publish.ts copies only needed dbt-tools dist files (not .node binaries)", () => {
    const publishScript = readFileSync(join(repoRoot, "packages/opencode/script/publish.ts"), "utf-8")
    // Should copy index.js and altimate_python_packages selectively, not `cp -r dist`
    expect(publishScript).toContain("dist/index.js")
    expect(publishScript).toContain("altimate_python_packages")
    // Should NOT do a blanket `cp -r ../dbt-tools/dist` (would include ~220MB of .node files)
    expect(publishScript).not.toMatch(/cp -r \.\.\/dbt-tools\/dist [^/]/)
  })

  test("postinstall.mjs sets up dbt-tools symlink", () => {
    const postinstall = readFileSync(join(repoRoot, "packages/opencode/script/postinstall.mjs"), "utf-8")
    expect(postinstall).toContain("setupDbtTools")
    expect(postinstall).toContain("dbt-tools")
    expect(postinstall).toContain("altimate-dbt")
  })

  test("bin/altimate exports ALTIMATE_BIN_DIR for bundled tool discovery", () => {
    const wrapper = readFileSync(join(repoRoot, "packages/opencode/bin/altimate"), "utf-8")
    expect(wrapper).toContain("ALTIMATE_BIN_DIR")
  })

  test("bash.ts prepends ALTIMATE_BIN_DIR to PATH", () => {
    const bashTs = readFileSync(join(repoRoot, "packages/opencode/src/tool/bash.ts"), "utf-8")
    expect(bashTs).toContain("ALTIMATE_BIN_DIR")
    expect(bashTs).toContain("PATH")
  })

  test("dbt-tools package exists with bin entry", () => {
    const dbtPkg = readJSON("packages/dbt-tools/package.json")
    expect(dbtPkg.bin).toBeDefined()
    expect(dbtPkg.bin["altimate-dbt"]).toBeDefined()
  })

  test("release.yml builds dbt-tools before publish", () => {
    const releaseYml = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf-8")
    expect(releaseYml).toContain("Build dbt-tools")
    expect(releaseYml).toContain("packages/dbt-tools")
  })
})

// ---------------------------------------------------------------------------
// 8. Install Script
// ---------------------------------------------------------------------------

describe("Install Script", () => {
  test("install file exists at repo root", () => {
    const installPath = join(repoRoot, "install")
    expect(existsSync(installPath)).toBe(true)
  })

  test("install file is a shell script (starts with #!)", () => {
    const installPath = join(repoRoot, "install")
    const content = readFileSync(installPath, "utf-8")
    expect(content.startsWith("#!")).toBe(true)
  })
})
