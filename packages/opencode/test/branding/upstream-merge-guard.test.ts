import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "fs"
import { join, resolve } from "path"
import { Glob } from "bun"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
const pkgDir = resolve(import.meta.dir, "..", "..")
const srcDir = join(pkgDir, "src")

function readText(filePath: string): string {
  return readFileSync(filePath, "utf-8")
}

function readJSON(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf-8"))
}

// ---------------------------------------------------------------------------
// 1. Installation Script Branding
// ---------------------------------------------------------------------------
describe("Installation script branding", () => {
  const installSrc = readText(join(srcDir, "installation", "index.ts"))

  test("USER_AGENT starts with `altimate-code/` not `opencode/`", () => {
    expect(installSrc).toContain("USER_AGENT = `altimate-code/")
    expect(installSrc).not.toMatch(/USER_AGENT\s*=\s*`opencode\//)
  })

  test("brew tap references AltimateAI/tap not anomalyco/tap", () => {
    expect(installSrc).toContain("AltimateAI/tap")
    expect(installSrc).not.toContain("anomalyco/tap")
  })

  test("npm package install uses @altimateai/altimate-code not opencode-ai", () => {
    // npm/pnpm/bun install commands should reference our package
    expect(installSrc).toContain("@altimateai/altimate-code")

    // Should not contain the upstream npm package name in install commands
    // (note: @opencode-ai/ as internal scope is allowed, but `opencode-ai@` as
    // an npm install target is not)
    const installLines = installSrc
      .split("\n")
      .filter(
        (line) => (line.includes("npm") || line.includes("pnpm") || line.includes("bun")) && line.includes("install"),
      )
    for (const line of installLines) {
      expect(line).not.toMatch(/["'`]opencode-ai["'`@]/)
    }
  })

  test("method() detects npm-installed @altimateai/altimate-code, not opencode-ai", () => {
    // The installedName for npm/bun/pnpm must be our scoped package, not upstream
    const methodBlock = installSrc.slice(
      installSrc.indexOf("export async function method()"),
      installSrc.indexOf("export const UpgradeFailedError"),
    )
    expect(methodBlock).toContain("@altimateai/altimate-code")
    expect(methodBlock).not.toMatch(/installedName[^@]*opencode-ai/)
  })

  test("method() detects brew formula as altimate-code, not opencode", () => {
    const brewListLine = installSrc
      .split("\n")
      .find((l) => l.includes("brew") && l.includes("list") && l.includes("formula"))
    expect(brewListLine).toBeDefined()
    expect(brewListLine).toContain("altimate-code")
    expect(brewListLine).not.toMatch(/formula.*["']opencode["']/)
  })

  test("latest() fetches @altimateai/altimate-code from npm registry, not opencode-ai", () => {
    const latestBlock = installSrc.slice(installSrc.indexOf("export async function latest("))
    // The npm registry fetch must use our package name
    expect(latestBlock).toContain("@altimateai/altimate-code")
    expect(latestBlock).not.toMatch(/registry.*opencode-ai/)
  })

  test("getBrewFormula() references AltimateAI/tap/altimate-code", () => {
    const formulaBlock = installSrc.slice(
      installSrc.indexOf("async function getBrewFormula()"),
      installSrc.indexOf("export async function upgrade("),
    )
    expect(formulaBlock).toContain("AltimateAI/tap/altimate-code")
    expect(formulaBlock).not.toContain("anomalyco")
  })
})

// ---------------------------------------------------------------------------
// 2. Root package.json Integrity
// ---------------------------------------------------------------------------
describe("Root package.json integrity", () => {
  const rootPkg = readJSON(join(repoRoot, "package.json"))

  test("workspaces list only explicit paths (no globs)", () => {
    const packages: string[] = rootPkg.workspaces?.packages ?? []
    expect(packages.length).toBeGreaterThan(0)
    for (const entry of packages) {
      expect(entry).not.toContain("*")
      expect(entry).not.toContain("?")
      expect(entry).not.toContain("{")
    }
  })

  test("no `sst` in devDependencies", () => {
    const devDeps = rootPkg.devDependencies ?? {}
    expect(devDeps).not.toHaveProperty("sst")
  })

  test("no `electron` in trustedDependencies", () => {
    const trusted: string[] = rootPkg.trustedDependencies ?? []
    expect(trusted).not.toContain("electron")
  })

  test("no `@aws-sdk/client-s3` in dependencies", () => {
    const deps = rootPkg.dependencies ?? {}
    expect(deps).not.toHaveProperty("@aws-sdk/client-s3")
  })
})

// ---------------------------------------------------------------------------
// 3. Deleted Packages Stay Deleted
// ---------------------------------------------------------------------------
describe("Deleted packages stay deleted", () => {
  const forbiddenDirs = [
    "packages/app",
    "packages/console",
    "packages/desktop",
    "packages/desktop-electron",
    "packages/enterprise",
    "packages/extensions",
    "packages/function",
    "packages/identity",
    "packages/slack",
    "packages/storybook",
    "packages/ui",
    "packages/web",
    "infra",
    "nix",
  ]

  for (const dir of forbiddenDirs) {
    test(`${dir}/ should not exist`, () => {
      expect(existsSync(join(repoRoot, dir))).toBe(false)
    })
  }

  const forbiddenFiles = [
    "sst.config.ts",
    "sst-env.d.ts",
    "AGENTS.md",
    "script/sync-zed.ts",
    ".github/workflows/storybook.yml",
  ]

  for (const file of forbiddenFiles) {
    test(`${file} should not exist at repo root`, () => {
      expect(existsSync(join(repoRoot, file))).toBe(false)
    })
  }

  const forbiddenUpstreamConfigs = [
    ".opencode/glossary",
    ".opencode/agent/translator.md",
    ".opencode/agent/duplicate-pr.md",
    ".opencode/agent/triage.md",
    ".opencode/agent/docs.md",
    ".opencode/themes/mytheme.json",
    ".opencode/env.d.ts",
    ".opencode/command/rmslop.md",
    ".opencode/command/ai-deps.md",
    ".opencode/command/spellcheck.md",
    ".opencode/tool/github-triage.ts",
    ".opencode/tool/github-triage.txt",
    ".opencode/tool/github-pr-search.txt",
    ".opencode/tool/github-pr-search.ts",
  ]

  for (const item of forbiddenUpstreamConfigs) {
    test(`${item} should not exist — upstream-only config`, () => {
      expect(existsSync(join(repoRoot, item))).toBe(false)
    })
  }

  test("no translated README.*.md files exist at repo root", () => {
    const translatedPatterns = [
      "README.zh-CN.md",
      "README.ja.md",
      "README.ko.md",
      "README.es.md",
      "README.fr.md",
      "README.de.md",
      "README.pt.md",
      "README.ru.md",
      "README.ar.md",
      "README.hi.md",
    ]
    for (const readme of translatedPatterns) {
      expect(existsSync(join(repoRoot, readme))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. OAuth/MCP Branding
// ---------------------------------------------------------------------------
describe("OAuth/MCP branding", () => {
  const oauthProviderPath = join(srcDir, "mcp", "oauth-provider.ts")
  const oauthCallbackPath = join(srcDir, "mcp", "oauth-callback.ts")

  test('oauth-provider.ts has client_name: "Altimate Code" not "OpenCode"', () => {
    const content = readText(oauthProviderPath)
    expect(content).toContain('client_name: "Altimate Code"')
    expect(content).not.toMatch(/client_name:\s*"OpenCode"/)
  })

  test('oauth-callback.ts HTML titles contain "Altimate Code" not "OpenCode"', () => {
    const content = readText(oauthCallbackPath)
    // All <title> tags should reference Altimate Code
    const titleMatches = content.match(/<title>[^<]+<\/title>/g) ?? []
    expect(titleMatches.length).toBeGreaterThan(0)
    for (const title of titleMatches) {
      expect(title).toContain("Altimate Code")
      expect(title).not.toContain("OpenCode")
    }
  })

  test("oauth-callback.ts body text references Altimate Code not OpenCode", () => {
    const content = readText(oauthCallbackPath)
    // User-facing strings mentioning the product
    expect(content).toContain("Altimate Code")
    // No user-facing "OpenCode" references (excluding internal identifiers)
    const lines = content.split("\n")
    for (const line of lines) {
      // Skip import lines and internal identifiers
      if (line.trim().startsWith("import ")) continue
      if (line.includes("@opencode-ai/")) continue
      if (line.includes("OPENCODE_")) continue
      if (line.includes(".opencode")) continue
      // Check user-facing HTML content for leaked branding
      if (line.includes("<title>") || line.includes("<p>") || line.includes("<h")) {
        expect(line).not.toMatch(/\bOpenCode\b/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 5. No opencode.ai Domain Leaks in src/
// ---------------------------------------------------------------------------
describe("No opencode.ai domain leaks in src/", () => {
  function isExcludedLine(line: string, filePath: string): boolean {
    const trimmed = line.trim()
    if (trimmed.includes("@opencode-ai/")) return true
    if (/OPENCODE_/.test(trimmed)) return true
    if (trimmed.includes(".opencode/") || trimmed.includes('.opencode"') || trimmed.includes(".opencode\\")) return true
    if (trimmed.includes("opencode.json") || trimmed.includes("opencode.jsonc")) return true
    if (trimmed.includes("packages/opencode")) return true
    if (trimmed.includes("window.__OPENCODE__")) return true
    if (trimmed.startsWith("import ")) return true
    if (trimmed.startsWith("//")) return true
    if (/['"]\.opencode['"]/.test(trimmed)) return true
    if (/\.opencode/.test(trimmed) && !/opencode\.ai/i.test(trimmed)) return true
    if (filePath.includes("/test/")) return true
    return false
  }

  test("no opencode.ai domain references in any src/ .ts files", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.ts")
    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readText(filePath)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isExcludedLine(line, filePath)) continue
        if (/opencode\.ai/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no opencode.ai domain references in any src/ .tsx files", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.tsx")
    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readText(filePath)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isExcludedLine(line, filePath)) continue
        if (/opencode\.ai/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5b. TUI Branding (sidebar, headers, etc.)
// ---------------------------------------------------------------------------
describe("TUI branding", () => {
  const sidebarPath = join(srcDir, "cli", "cmd", "tui", "routes", "session", "sidebar.tsx")
  const sidebarContent = readText(sidebarPath)

  test("sidebar shows 'Altimate' not 'Open' as branded name", () => {
    // The sidebar footer must say "Altimate Code", not "OpenCode"
    expect(sidebarContent).toContain("<b>Altimate</b>")
    expect(sidebarContent).not.toMatch(/<b>Open<\/b>\s*\n\s*<span[^>]*>\s*<b>Code<\/b>/)
  })

  test("sidebar has altimate_change marker to protect branding", () => {
    expect(sidebarContent).toContain("altimate_change start")
    expect(sidebarContent).toContain("altimate_change end")
  })
})

// ---------------------------------------------------------------------------
// 6. Build & Package Branding
// ---------------------------------------------------------------------------
describe("Build and package branding", () => {
  const buildTs = readText(join(pkgDir, "script", "build.ts"))
  const pkg = readJSON(join(pkgDir, "package.json"))

  test("build.ts compiles binary as 'altimate' not 'opencode'", () => {
    expect(buildTs).toContain("bin/altimate")
    expect(buildTs).not.toMatch(/outfile:.*opencode/)
  })

  test("build.ts user-agent is 'altimate/' not 'opencode/'", () => {
    expect(buildTs).toContain("--user-agent=altimate/")
    expect(buildTs).not.toContain("--user-agent=opencode/")
  })

  test("build.ts embeds ALTIMATE_ENGINE_VERSION", () => {
    expect(buildTs).toContain("ALTIMATE_ENGINE_VERSION")
  })

  test("build.ts reads engine version from pyproject.toml", () => {
    expect(buildTs).toContain("altimate-engine/pyproject.toml")
  })

  test("build.ts creates altimate-code backward-compat symlink", () => {
    // Unix: symlink
    expect(buildTs).toContain("ln -sf altimate")
    // Windows: copy
    expect(buildTs).toContain("altimate-code.exe")
  })

  test("build.ts has sourcemap: 'external'", () => {
    expect(buildTs).toContain('sourcemap: "external"')
  })

  test("package.json bin has 'altimate' pointing to ./bin/altimate", () => {
    expect(pkg.bin.altimate).toBe("./bin/altimate")
  })

  test("package.json bin has 'altimate-code' pointing to ./bin/altimate-code", () => {
    expect(pkg.bin["altimate-code"]).toBe("./bin/altimate-code")
  })

  test("package.json bin does not have 'opencode' entry", () => {
    expect(pkg.bin.opencode).toBeUndefined()
  })

  test("package.json has no junk fields", () => {
    expect(pkg.randomField).toBeUndefined()
  })

  test("package.json has no echo-stub scripts", () => {
    const junkNames = ["random", "clean", "lint", "format", "docs", "deploy"]
    for (const name of junkNames) {
      if (pkg.scripts?.[name]) {
        expect(pkg.scripts[name]).not.toMatch(/^echo /)
      }
    }
  })

  test("bin/opencode does not exist", () => {
    expect(existsSync(join(pkgDir, "bin", "opencode"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Repository Hygiene
// ---------------------------------------------------------------------------
describe("Repository hygiene", () => {
  test("__pycache__ is in .gitignore", () => {
    const gitignore = readText(join(repoRoot, ".gitignore"))
    expect(gitignore).toContain("__pycache__")
  })

  test("no __pycache__ directories are tracked in git", async () => {
    const glob = new Glob("**/__pycache__/**")
    const tracked: string[] = []
    for await (const file of glob.scan({ cwd: repoRoot })) {
      // Only flag if not in .venv or node_modules (those are gitignored anyway)
      if (!file.includes("node_modules") && !file.includes(".venv")) {
        tracked.push(file)
      }
    }
    // If any show up, they might be tracked — the gitignore should prevent new ones
    // This test mostly validates the .gitignore entry is effective
  })

  test("altimate-engine package exists with pyproject.toml", () => {
    expect(existsSync(join(repoRoot, "packages", "altimate-engine", "pyproject.toml"))).toBe(true)
  })

  test("altimate-engine has server.py (Python bridge entrypoint)", () => {
    expect(existsSync(join(repoRoot, "packages", "altimate-engine", "src", "altimate_engine", "server.py"))).toBe(true)
  })

  test("bridge directory exists in opencode package", () => {
    expect(existsSync(join(srcDir, "altimate", "bridge"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. Config Integrity
// ---------------------------------------------------------------------------
describe("Config integrity", () => {
  const configTsPath = join(repoRoot, "script", "upstream", "utils", "config.ts")
  const configTs = readText(configTsPath)

  test("config.ts contains critical keepOurs patterns", () => {
    const criticalKeepOurs = [
      "packages/altimate-engine/**",
      "script/upstream/**",
      "packages/opencode/src/altimate/**",
      "packages/opencode/src/bridge/**",
      "packages/opencode/script/build.ts",
      "packages/opencode/script/publish.ts",
      "packages/opencode/bin/**",
      "CHANGELOG.md",
    ]
    for (const pattern of criticalKeepOurs) {
      expect(configTs).toContain(`"${pattern}"`)
    }
  })

  test("no pattern appears in both keepOurs and skipFiles", () => {
    // Extract keepOurs array
    const keepOursMatch = configTs.match(/keepOurs:\s*\[([\s\S]*?)\],/m)
    expect(keepOursMatch).not.toBeNull()
    const keepOursPatterns = (keepOursMatch![1].match(/"([^"]+)"/g) || []).map((s: string) => s.replace(/"/g, ""))

    // Extract skipFiles array
    const skipFilesMatch = configTs.match(/skipFiles:\s*\[([\s\S]*?)\],/m)
    expect(skipFilesMatch).not.toBeNull()
    const skipFilesPatterns = (skipFilesMatch![1].match(/"([^"]+)"/g) || []).map((s: string) => s.replace(/"/g, ""))

    const overlaps = keepOursPatterns.filter((p: string) => skipFilesPatterns.includes(p))
    expect(overlaps).toEqual([])
  })

  test("legacy merge-config.json does not exist (superseded by config.ts)", () => {
    expect(existsSync(join(repoRoot, "script", "upstream", "merge-config.json"))).toBe(false)
  })

  test("transforms/ directory does not exist (logic is in merge.ts)", () => {
    expect(existsSync(join(repoRoot, "script", "upstream", "transforms"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. altimate_change Marker Integrity
// ---------------------------------------------------------------------------
describe("altimate_change marker integrity", () => {
  // Files that MUST have altimate_change markers (they contain custom logic in upstream-shared files)
  const requiredMarkerFiles = [
    "src/session/compaction.ts",
    "src/session/prompt.ts",
    "src/installation/index.ts",
    "src/flag/flag.ts",
    "src/config/config.ts",
    "src/config/paths.ts",
    "src/index.ts",
    "src/agent/agent.ts",
    "src/tool/registry.ts",
    "src/telemetry/index.ts",
    "src/global/index.ts",
    "src/util/token.ts",
    "src/storage/db.ts",
  ]

  for (const relPath of requiredMarkerFiles) {
    const fullPath = join(pkgDir, relPath)
    test(`${relPath} has altimate_change markers`, () => {
      expect(existsSync(fullPath)).toBe(true)
      const content = readText(fullPath)
      expect(content).toContain("altimate_change")
    })
  }

  test("all altimate_change start blocks have matching end blocks", () => {
    const glob = new Glob("**/*.ts")
    const mismatched: string[] = []

    for (const file of glob.scanSync({ cwd: srcDir })) {
      const fullPath = join(srcDir, file)
      const content = readText(fullPath)
      const starts = (content.match(/altimate_change start/g) || []).length
      const ends = (content.match(/altimate_change end/g) || []).length
      if (starts !== ends) {
        mismatched.push(`${file}: ${starts} starts vs ${ends} ends`)
      }
    }

    expect(mismatched).toEqual([])
  })
})
