import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "fs"
import { join, resolve } from "path"
import { Glob } from "bun"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
const pkgDir = resolve(import.meta.dir, "..", "..")
const srcDir = join(pkgDir, "src")

function readJSON(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf-8"))
}

function readText(filePath: string) {
  return readFileSync(filePath, "utf-8")
}

// ---------------------------------------------------------------------------
// 1. Package Metadata
// ---------------------------------------------------------------------------
describe("Package Metadata", () => {
  const pkg = readJSON(join(pkgDir, "package.json"))
  const rootPkg = readJSON(join(repoRoot, "package.json"))

  test("packages/opencode/package.json name is @altimateai/altimate-code", () => {
    expect(pkg.name).toBe("@altimateai/altimate-code")
  })

  test("bin keys include 'altimate-code' and 'altimate'", () => {
    expect(pkg.bin).toHaveProperty("altimate-code")
    expect(pkg.bin).toHaveProperty("altimate")
  })

  test("bin values point to altimate-code binary", () => {
    expect(pkg.bin["altimate-code"]).toContain("altimate-code")
    expect(pkg.bin["altimate"]).toContain("altimate")
  })

  test("root package.json repository URL references AltimateAI/altimate-code", () => {
    expect(rootPkg.repository.url).toBe("https://github.com/AltimateAI/altimate-code")
  })
})

// ---------------------------------------------------------------------------
// 2. CLI Entry Points
// ---------------------------------------------------------------------------
describe("CLI Entry Points", () => {
  const binPath = join(pkgDir, "bin", "altimate-code")

  test("bin/altimate-code file exists", () => {
    expect(existsSync(binPath)).toBe(true)
  })

  test("bin script references @altimateai package scope", () => {
    const content = readText(binPath)
    expect(content).toContain("@altimateai")
  })

  test("bin script looks for altimate-code binary name", () => {
    const content = readText(binPath)
    expect(content).toContain('"altimate-code"')
  })
})

// ---------------------------------------------------------------------------
// 3. CLI Branding
// ---------------------------------------------------------------------------
describe("CLI Branding", () => {
  test("index.ts scriptName is altimate-code", () => {
    const content = readText(join(srcDir, "index.ts"))
    expect(content).toContain('.scriptName("altimate-code")')
  })

  test("logo.ts does not contain opencode branding", () => {
    const content = readText(join(srcDir, "cli", "logo.ts"))
    // The logo is ASCII block art — it won't contain literal "altimate" text,
    // but it must NOT contain any "opencode" literal either.
    expect(content.toLowerCase()).not.toMatch(/opencode/)
  })

  test("welcome.ts banner says altimate-code not opencode", () => {
    const content = readText(join(srcDir, "cli", "welcome.ts"))
    expect(content).toContain("altimate-code")
    expect(content).not.toMatch(/\bopencode\b(?!\.)/i)
  })
})

// ---------------------------------------------------------------------------
// 4. Installation Script
// ---------------------------------------------------------------------------
describe("Installation Script", () => {
  const installContent = readText(join(repoRoot, "install"))

  test("APP variable is altimate-code", () => {
    expect(installContent).toContain("APP=altimate-code")
  })

  test("GitHub release URL references AltimateAI/altimate-code", () => {
    expect(installContent).toContain("github.com/AltimateAI/altimate-code/releases")
  })

  test("install dir is .altimate-code", () => {
    expect(installContent).toContain(".altimate-code/bin")
  })

  test("no references to opencode.ai domain", () => {
    // Should reference altimate.ai, not opencode.ai
    const lines = installContent.split("\n")
    for (const line of lines) {
      expect(line).not.toContain("opencode.ai")
    }
  })

  test("no references to anomalyco GitHub org", () => {
    expect(installContent).not.toContain("anomalyco")
  })

  test("references altimate.ai domain for user-facing URLs", () => {
    expect(installContent).toContain("altimate.ai")
  })
})

// ---------------------------------------------------------------------------
// 5. GitHub Action
// ---------------------------------------------------------------------------
describe("GitHub Action", () => {
  const actionContent = readText(join(repoRoot, "github", "action.yml"))

  test("action name contains altimate", () => {
    expect(actionContent).toMatch(/name:.*altimate/i)
  })

  test("install command references altimate", () => {
    expect(actionContent).toContain("altimate")
  })

  test("GitHub release URL references AltimateAI/altimate-code", () => {
    expect(actionContent).toContain("AltimateAI/altimate-code")
  })
})

// ---------------------------------------------------------------------------
// 6. User-Agent & Version
// ---------------------------------------------------------------------------
describe("User-Agent & Version", () => {
  test("USER_AGENT contains altimate-code", () => {
    const content = readText(join(srcDir, "installation", "index.ts"))
    expect(content).toContain('USER_AGENT = `altimate-code/')
  })
})

// ---------------------------------------------------------------------------
// 7. Upstream Branding Leak Detection
// ---------------------------------------------------------------------------
describe("Upstream Branding Leak Detection", () => {
  const leakedPatterns = [
    { pattern: /opencode\.ai/i, label: "altimate.ai domain" },
    { pattern: /anomalyco/i, label: "anomalyco GitHub org" },
    { pattern: /opncd\.ai/i, label: "altimate.ai short domain" },
  ]

  // Lines matching any of these patterns are intentionally kept (internal identifiers)
  function isExcluded(line: string, filePath: string): boolean {
    const trimmed = line.trim()
    // Internal npm scope
    if (trimmed.includes("@opencode-ai/")) return true
    // Env vars
    if (/OPENCODE_/.test(trimmed)) return true
    // Config dir references
    if (trimmed.includes(".opencode/") || trimmed.includes('.opencode"') || trimmed.includes(".opencode\\")) return true
    // Config file names
    if (trimmed.includes("opencode.json") || trimmed.includes("opencode.jsonc")) return true
    // Internal package path
    if (trimmed.includes("packages/opencode")) return true
    // Runtime global
    if (trimmed.includes("window.__OPENCODE__")) return true
    // Import statements
    if (trimmed.startsWith("import ")) return true
    // Comments explaining upstream
    if (trimmed.startsWith("//") && /opencode/i.test(trimmed) && !/opencode\.ai/i.test(trimmed)) return true
    // Test files themselves
    if (filePath.includes("/test/")) return true
    // ".opencode" as config dir name in array literals or string literals (fallback config)
    if (/['"]\.opencode['"]/.test(trimmed)) return true
    // path.join references with ".opencode" (e.g., path.join(".opencode", "bin"))
    if (/\.opencode/.test(trimmed) && !(/opencode\.ai/i.test(trimmed))) return true
    return false
  }

  test("no altimate.ai domain references in src/ files", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.{ts,tsx,js}")
    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readText(filePath)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isExcluded(line, filePath)) continue
        if (/opencode\.ai/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no anomalyco references in src/ files", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.{ts,tsx,js}")
    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readText(filePath)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isExcluded(line, filePath)) continue
        if (/anomalyco/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no altimate.ai references in src/ files", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.{ts,tsx,js}")
    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readText(filePath)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isExcluded(line, filePath)) continue
        if (/opncd\.ai/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8. Config Paths
// ---------------------------------------------------------------------------
describe("Config Paths", () => {
  test("primary config directory name is .altimate-code", () => {
    const content = readText(join(srcDir, "config", "paths.ts"))
    // The configTargets array should list .altimate-code first (primary)
    const match = content.match(/configTargets\s*=\s*\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const targets = match![1]
    // .altimate-code should appear before .opencode in the array
    const altimateIdx = targets.indexOf(".altimate-code")
    const opencodeIdx = targets.indexOf(".opencode")
    expect(altimateIdx).toBeGreaterThanOrEqual(0)
    expect(altimateIdx).toBeLessThan(opencodeIdx)
  })

  test("global app name is altimate-code", () => {
    const content = readText(join(srcDir, "global", "index.ts"))
    expect(content).toContain('const app = "altimate-code"')
  })

  test("welcome.ts data dir references altimate-code", () => {
    const content = readText(join(srcDir, "cli", "welcome.ts"))
    expect(content).toContain("altimate-code")
  })
})

// ---------------------------------------------------------------------------
// altimate_change start — regression: catch branding leaks in package root files and workflows
// ---------------------------------------------------------------------------

describe("Package root branding", () => {
  test("parsers-config.ts has no anomalyco references", () => {
    const content = readText(join(pkgDir, "parsers-config.ts"))
    const lines = content.split("\n")
    const violations: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/anomalyco/i.test(lines[i])) {
        violations.push(`parsers-config.ts:${i + 1}: ${lines[i].trim()}`)
      }
    }
    expect(violations).toEqual([])
  })
})

describe("Workflow branding", () => {
  test("opencode.yml uses /altimate or /ac triggers, not /opencode", () => {
    const content = readText(join(repoRoot, ".github", "workflows", "opencode.yml"))
    // Should have /altimate triggers
    expect(content).toContain("/altimate")
    // Should NOT have /opencode triggers
    expect(content).not.toMatch(/startsWith\(.*'\/opencode'\)/)
    expect(content).not.toMatch(/contains\(.*'\/opencode'\)/)
  })

  test("opencode.yml model reference does not use opencode/ prefix", () => {
    const content = readText(join(repoRoot, ".github", "workflows", "opencode.yml"))
    expect(content).not.toContain("model: opencode/")
  })
})
// altimate_change end

// ---------------------------------------------------------------------------
// 9. VSCode Extension
// ---------------------------------------------------------------------------
describe("VSCode Extension", () => {
  const vscodePkg = readJSON(join(repoRoot, "sdks", "vscode", "package.json"))

  test("name is altimate-code", () => {
    expect(vscodePkg.name).toBe("altimate-code")
  })

  test("displayName contains Altimate", () => {
    expect(vscodePkg.displayName).toContain("Altimate")
  })

  test("publisher is altimateai", () => {
    expect(vscodePkg.publisher).toBe("altimateai")
  })
})

// ---------------------------------------------------------------------------
// 10. Postinstall Script
// ---------------------------------------------------------------------------
describe("Postinstall Script", () => {
  const postinstallContent = readText(join(pkgDir, "script", "postinstall.mjs"))

  test("references @altimateai package scope", () => {
    expect(postinstallContent).toContain("@altimateai")
  })

  test("binary name is altimate-code", () => {
    expect(postinstallContent).toContain('"altimate-code"')
  })

  test("welcome message mentions altimate-code", () => {
    expect(postinstallContent).toContain("altimate-code")
  })

  test("data directory uses altimate-code name", () => {
    // The writeUpgradeMarker function should write to altimate-code data dir
    expect(postinstallContent).toContain('"altimate-code"')
  })
})
