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
    const installLines = installSrc.split("\n").filter(
      (line) =>
        (line.includes("npm") || line.includes("pnpm") || line.includes("bun")) &&
        line.includes("install"),
    )
    for (const line of installLines) {
      expect(line).not.toMatch(/["'`]opencode-ai["'`@]/)
    }
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

  const forbiddenFiles = ["sst.config.ts", "sst-env.d.ts"]

  for (const file of forbiddenFiles) {
    test(`${file} should not exist at repo root`, () => {
      expect(existsSync(join(repoRoot, file))).toBe(false)
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

  test("oauth-provider.ts has client_name: \"Altimate Code\" not \"OpenCode\"", () => {
    const content = readText(oauthProviderPath)
    expect(content).toContain('client_name: "Altimate Code"')
    expect(content).not.toMatch(/client_name:\s*"OpenCode"/)
  })

  test("oauth-callback.ts HTML titles contain \"Altimate Code\" not \"OpenCode\"", () => {
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
