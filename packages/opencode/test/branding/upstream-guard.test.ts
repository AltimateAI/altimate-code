import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "fs"
import { join, resolve } from "path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")

// altimate_change start — config.ts is now single source of truth (merge-config.json removed)
const brandingConfigPath = join(repoRoot, "script", "upstream", "utils", "config.ts")
const brandingConfigText = readFileSync(brandingConfigPath, "utf-8")
// altimate_change end

const rootPkgPath = join(repoRoot, "package.json")
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf-8"))

describe("upstream merge guards", () => {
  describe("skip files configuration", () => {
    const expectedSkipPatterns = [
      "packages/app/**",
      "packages/console/**",
      "packages/containers/**",
      "packages/desktop/**",
      "packages/desktop-electron/**",
      "packages/docs/**",
      "packages/enterprise/**",
      "packages/extensions/**",
      "packages/function/**",
      "packages/identity/**",
      "packages/slack/**",
      "packages/storybook/**",
      "packages/ui/**",
      "packages/web/**",
      "infra/**",
      "nix/**",
      "flake.nix",
      "flake.lock",
      "sst.config.ts",
      "sst-env.d.ts",
      "specs/**",
      "README.*.md",
      // Upstream project-specific configs
      ".opencode/glossary/**",
      ".opencode/agent/translator.md",
      ".opencode/tool/github-triage.ts",
      ".opencode/tool/github-triage.txt",
      ".opencode/tool/github-pr-search.txt",
      ".opencode/tool/github-pr-search.ts",
      ".opencode/agent/duplicate-pr.md",
      ".opencode/agent/triage.md",
      ".opencode/agent/docs.md",
      ".opencode/themes/mytheme.json",
      ".opencode/env.d.ts",
      ".opencode/command/rmslop.md",
      ".opencode/command/ai-deps.md",
      ".opencode/command/spellcheck.md",
      ".github/workflows/storybook.yml",
      "script/sync-zed.ts",
      "AGENTS.md",
    ]

    for (const pattern of expectedSkipPatterns) {
      test(`skipFiles contains "${pattern}"`, () => {
        expect(brandingConfigText).toContain(pattern)
      })
    }
  })

  describe("keep ours configuration", () => {
    const expectedKeepOurs = [
      "packages/altimate-engine/**",
      "script/upstream/**",
      "README.md",
      ".github/workflows/**",
    ]

    for (const pattern of expectedKeepOurs) {
      test(`keepOurs contains "${pattern}"`, () => {
        expect(brandingConfigText).toContain(pattern)
      })
    }
  })

  describe("skipped packages do not exist on disk", () => {
    const skippedPackageDirs = [
      "packages/app",
      "packages/console",
      "packages/containers",
      "packages/desktop",
      "packages/desktop-electron",
      "packages/docs",
      "packages/enterprise",
      "packages/extensions",
      "packages/function",
      "packages/identity",
      "packages/slack",
      "packages/storybook",
      "packages/ui",
      "packages/web",
    ]

    for (const dir of skippedPackageDirs) {
      test(`${dir}/ should not exist — upstream package must stay removed`, () => {
        const fullPath = join(repoRoot, dir)
        expect(existsSync(fullPath)).toBe(false)
      })
    }
  })

  describe("keep ours directories exist on disk", () => {
    const keepOursDirs = [
      "packages/drivers",
      "script/upstream",
    ]

    for (const dir of keepOursDirs) {
      test(`${dir}/ should exist — custom code must not be deleted`, () => {
        const fullPath = join(repoRoot, dir)
        expect(existsSync(fullPath)).toBe(true)
      })
    }
  })

  describe("branding rules completeness", () => {
    test('contains "altimate.ai" domain replacement rule', () => {
      // In regex patterns, dots are escaped as \. so check for the regex form
      expect(brandingConfigText).toMatch(/opencode\\?\.ai/)
    })

    test('contains "anomalyco" GitHub org replacement rule', () => {
      expect(brandingConfigText).toContain("anomalyco")
    })

    test('contains "Altimate Code" product name replacement rule', () => {
      expect(brandingConfigText).toContain("Altimate Code")
    })

    test('contains "altimate.ai" as replacement target', () => {
      expect(brandingConfigText).toContain("altimate.ai")
    })

    test('contains "AltimateAI" as replacement target', () => {
      expect(brandingConfigText).toContain("AltimateAI")
    })

    test('contains "Altimate Code" as replacement target', () => {
      expect(brandingConfigText).toContain("Altimate Code")
    })
  })

  describe("preserve patterns", () => {
    const expectedPreservePatterns = [
      "@opencode-ai/",
      "OPENCODE_",
      "packages/opencode",
      ".opencode/",
    ]

    for (const pattern of expectedPreservePatterns) {
      test(`preservePatterns includes "${pattern}"`, () => {
        expect(brandingConfigText).toContain(pattern)
      })
    }
  })

  describe("transformable extensions", () => {
    const expectedExtensions = [".ts", ".tsx", ".js", ".json", ".md", ".yml", ".yaml"]

    for (const ext of expectedExtensions) {
      test(`transformableExtensions includes "${ext}"`, () => {
        expect(brandingConfigText).toContain(`"${ext}"`)
      })
    }
  })

  describe("change marker", () => {
    test('changeMarker is "altimate_change"', () => {
      expect(brandingConfigText).toContain('"altimate_change"')
    })
  })

  describe("no upstream-only artifacts in repo", () => {
    const forbiddenFiles = [
      "flake.nix",
      "flake.lock",
      "sst.config.ts",
      "sst-env.d.ts",
      "AGENTS.md",
      "script/sync-zed.ts",
      ".github/workflows/storybook.yml",
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

    const forbiddenDirs = ["nix", "specs", "infra", ".signpath", ".opencode/glossary"]

    for (const file of forbiddenFiles) {
      test(`${file} should not exist at repo root`, () => {
        expect(existsSync(join(repoRoot, file))).toBe(false)
      })
    }

    for (const dir of forbiddenDirs) {
      test(`${dir}/ directory should not exist at repo root`, () => {
        expect(existsSync(join(repoRoot, dir))).toBe(false)
      })
    }

    test("no translated README.*.md files exist at repo root", () => {
      // Check common translated README patterns
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

    const forbiddenPackages = [
      "packages/app",
      "packages/console",
      "packages/containers",
      "packages/desktop",
      "packages/desktop-electron",
      "packages/docs",
      "packages/enterprise",
      "packages/extensions",
      "packages/function",
      "packages/identity",
      "packages/slack",
      "packages/storybook",
      "packages/ui",
      "packages/web",
    ]

    for (const pkg of forbiddenPackages) {
      test(`${pkg}/ should not exist — upstream package must stay removed`, () => {
        expect(existsSync(join(repoRoot, pkg))).toBe(false)
      })
    }
  })

  describe("workspace consistency", () => {
    const workspacePackages: string[] = rootPkg.workspaces?.packages ?? []

    test("no workspace entry uses glob patterns — must be explicit paths", () => {
      for (const entry of workspacePackages) {
        expect(entry).not.toContain("*")
      }
    })

    for (const wsPath of workspacePackages) {
      test(`workspace "${wsPath}" exists and has a package.json`, () => {
        const dir = join(repoRoot, wsPath)
        expect(existsSync(dir)).toBe(true)

        const pkgJson = join(dir, "package.json")
        expect(existsSync(pkgJson)).toBe(true)
      })
    }
  })

  // altimate_change start — marker guard safety: ensure src/ files are never excluded
  describe("marker guard exclusions must never bypass src/ protection", () => {
    test("markerExcludePatterns in analyze.ts must not match packages/opencode/src/**/*.ts", () => {
      const analyzeContent = readFileSync(join(repoRoot, "script", "upstream", "analyze.ts"), "utf-8")
      // Extract markerExcludePatterns array
      const match = analyzeContent.match(/markerExcludePatterns\s*=\s*\[([\s\S]*?)\]/)
      expect(match).not.toBeNull()
      const patternsBlock = match![1]

      // These patterns must NEVER appear — they would bypass marker protection for source code
      const dangerousPatterns = [
        "packages/opencode/src/**",
        "packages/opencode/src/*.ts",
        "**/src/**",
        "**/*.ts",
      ]
      for (const dangerous of dangerousPatterns) {
        expect(patternsBlock).not.toContain(`"${dangerous}"`)
      }
    })

    test("CI marker guard runs in strict mode for non-merge PRs", () => {
      const ciContent = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf-8")
      // Must have --strict flag for regular PRs
      expect(ciContent).toContain("--strict")
      // Must detect merge branches to skip strict
      expect(ciContent).toContain("merge-upstream-")
    })
  })
  // altimate_change end
})
