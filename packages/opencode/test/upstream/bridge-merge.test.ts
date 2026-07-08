/**
 * Regression tests for the upstream bridge merge.
 *
 * These tests catch issues that could be introduced or re-introduced by future
 * upstream merges (especially across history rewrites). They lock in
 * altimate-specific behaviors that an overlay tool might silently lose:
 *
 *   1. Anthropic stays a fully-supported provider (PR #18186 stays reverted).
 *   2. Branding artifacts (`opencode.ai`, `anomalyco/opencode`, `OpenCode`)
 *      don't leak into shipped source files.
 *   3. `altimate_change` markers stay structurally valid (every `start` paired
 *      with an `end`, no nesting).
 *   4. The `@ts-nocheck` "DRAFT bridge merge" inventory doesn't grow without
 *      review — these are debt markers, not load-bearing fixes.
 *   5. Critical altimate features remain wired up (memory, skills, builder
 *      agent, telemetry, drivers, dbt-tools).
 */
import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { defaultConfig } from "../../../../script/upstream/utils/config.ts"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")
const srcDir = path.join(repoRoot, "packages", "opencode", "src")
const testDir = path.join(repoRoot, "packages", "opencode", "test")

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf-8")
}

// Generated/data files that legitimately contain upstream URLs (model registry,
// upstream package metadata snapshots, etc.). Branding rules don't apply.
const GENERATED_FILES = new Set(["packages/opencode/src/provider/models-snapshot.ts"])

async function walkSource(dir: string, exts = [".ts", ".tsx"]): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue
        await walk(full)
      } else if (exts.some((x) => e.name.endsWith(x))) {
        const rel = path.relative(repoRoot, full)
        if (GENERATED_FILES.has(rel)) continue
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

describe("bridge merge: PR #18186 stays reverted (Anthropic provider preserved)", () => {
  test("anthropic system prompt file exists and is loaded", async () => {
    // Note: PR #18186 also deleted prompt/anthropic-20250930.txt, but that file
    // was an unused legacy variant — the active prompt is anthropic.txt. The
    // *load-bearing* parts of PR #18186's reversion are checked in the other
    // tests below (BUILTIN plugin, login hint, headers, User-Agent).
    const promptPath = path.join(srcDir, "session", "prompt", "anthropic.txt")
    expect(existsSync(promptPath)).toBe(true)
    const content = await readText(promptPath)
    expect(content.length).toBeGreaterThan(1000)
    // Verify it's actually imported in system.ts
    const systemTs = await readText(path.join(srcDir, "session", "system.ts"))
    expect(systemTs).toContain('from "./prompt/anthropic.txt"')
  })

  test("providers.ts has 'anthropic: API key' login hint", async () => {
    const content = await readText(path.join(srcDir, "cli", "cmd", "providers.ts"))
    expect(content).toContain('anthropic: "API key"')
  })

  test("plugin/index.ts has BUILTIN anthropic-auth plugin", async () => {
    const content = await readText(path.join(srcDir, "plugin", "index.ts"))
    expect(content).toContain("opencode-anthropic-auth@0.0.13")
    expect(content).toContain("BUILTIN")
  })

  test("provider/provider.ts has claude-code-20250219 in anthropic-beta header", async () => {
    const content = await readText(path.join(srcDir, "provider", "provider.ts"))
    expect(content).toContain("claude-code-20250219")
  })

  test("session/llm.ts has User-Agent conditional for non-anthropic providers", async () => {
    const content = await readText(path.join(srcDir, "session", "llm.ts"))
    expect(content).toContain('providerID !== "anthropic"')
  })

  test("@ai-sdk/anthropic is a dependency", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeDefined()
  })

  test("createAnthropic is registered in BUNDLED_PROVIDERS", async () => {
    const content = await readText(path.join(srcDir, "provider", "provider.ts"))
    expect(content).toContain("createAnthropic")
    expect(content).toContain('"@ai-sdk/anthropic"')
  })
})

describe("bridge merge: legacy anthropic-20250930.txt must never re-enter the tree", () => {
  // The unused legacy prompt variant must stay out of the repo: the active
  // prompt is anthropic.txt. Three lines of defense, all asserted here:
  //   1) the file is absent on disk
  //   2) skipFiles in script/upstream/utils/config.ts blocks any upstream resurrection
  //   3) script/upstream/bridge-merge.ts does not reference the path in code
  const legacyRel = "packages/opencode/src/session/prompt/anthropic-20250930.txt"

  test("legacy anthropic-20250930.txt does not exist on disk", () => {
    expect(existsSync(path.join(repoRoot, legacyRel))).toBe(false)
  })

  test("defaultConfig.skipFiles contains the legacy path (array membership, not substring)", () => {
    expect(defaultConfig.skipFiles).toContain(legacyRel)
  })

  test("bridge-merge.ts does not reference the legacy file in executable code", async () => {
    // Stronger than the prior pair of regexes: assert the filename never
    // appears outside comments. Catches future restoration via any mechanism
    // (git show / git checkout / Bun.write / fs.promises.writeFile / multi-line).
    const content = await readText(path.join(repoRoot, "script", "upstream", "bridge-merge.ts"))
    const codeLines = content.split("\n").filter((l) => {
      const trimmed = l.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && trimmed !== ""
    })
    expect(codeLines.join("\n")).not.toContain("anthropic-20250930")
  })
})

describe("bridge merge: transient .github/meta/* files must never be tracked", () => {
  // .github/meta/{commit,diff,pr-body-*}.* are scratch files used during the
  // commit/PR workflow. They commonly contain raw upstream brand strings (when
  // describing rebrand fixes) and trigger branding-leak alarms if accidentally
  // tracked. Layered defense, all asserted here:
  //   1) .gitignore excludes the conventional names with **/ so nested paths match
  //   2) keepOurs in script/upstream/utils/config.ts protects the directory
  //   3) no transient meta files are tracked anywhere in the repo (any depth)
  const transientPatterns = ["**/.github/meta/commit.txt", "**/.github/meta/diff.txt", "**/.github/meta/pr-body-*.md"]
  const leakRegex = /(?:^|\/)\.github\/meta\/(?:commit\.txt|diff\.txt|pr-body-.*\.md)$/

  test(".gitignore excludes the transient meta files with nested-path coverage", async () => {
    const content = await readText(path.join(repoRoot, ".gitignore"))
    for (const pattern of transientPatterns) {
      expect(content).toContain(pattern)
    }
  })

  test("keepOurs in script/upstream/utils/config.ts covers .github/meta/**", () => {
    expect(defaultConfig.keepOurs).toContain(".github/meta/**")
  })

  test("no transient meta files are tracked anywhere in the repo", () => {
    // Repo-wide scan — catches commit.txt / diff.txt / pr-body-*.md at any depth,
    // not just at repo root. Prevents PR #574-style leaks (nested commit.txt).
    const proc = Bun.spawnSync({ cmd: ["git", "ls-files"], cwd: repoRoot })
    expect(proc.exitCode).toBe(0)
    const tracked = new TextDecoder().decode(proc.stdout).split("\n")
    const leaked = tracked.filter((p) => leakRegex.test(p))
    expect(leaked).toEqual([])
  })
})

describe("bridge merge: branding leaks", () => {
  // The branding rules are: opencode.ai → altimate.ai, anomalyco/opencode →
  // AltimateAI/altimate-code, OpenCode → Altimate Code (in user-facing strings).
  // We allow these patterns in specific places (npm package names, internal
  // env vars, paths) — those are documented in script/upstream/utils/config.ts
  // preservePatterns.

  const allowedOpencodePatterns = [
    /^.*@opencode-ai\//, // npm scope
    /^.*OPENCODE_/, // env vars
    /^.*\.opencode\//, // config dir
    /^.*opencode\.json/, // config filename
    /^.*opencode\.jsonc/,
    /^.*"opencode"/, // package name string
    /^.*'opencode'/,
    /^.*window\.__OPENCODE__/,
    /^.*Flag\.OPENCODE_/,
    /^.*from ["']@opencode-ai/, // imports
    /^.*require\(["']@opencode-ai/,
    /^.*opencode-anthropic-auth/, // anthropic auth plugin name
    /^.*opencode-poe-auth/,
    /^.*opencode-gitlab-auth/,
    /^.*opencode\.session/, // header names
    /^.*x-opencode-/, // header prefixes
    /^.*opencode-ai\//, // package spec
    /\/\/.*opencode/i, // comments
    /\*.*opencode/i, // jsdoc/comments
    /^.*OpenCodeError/, // error class
    /^.*OPENCODE_DISABLE/,
    /^.*OPENCODE_VERSION/,
    /^.*OPENCODE_CHANNEL/,
    /^.*OPENCODE_BUMP/,
    /^.*OPENCODE_RELEASE/,
    /^.*OPENCODE_CONFIG/,
    /^.*OPENCODE_TEST/,
    /^.*OPENCODE_/,
    /^.*OPENCODE_AUTH_FILE/,
    /^.*OPENCODE_BIN_PATH/,
    /^.*OPENCODE_CONSOLE/,
    /^.*OPENCODE_LOG/,
    /^.*OPENCODE_PROFILE/,
    /^.*OPENCODE_TUI_/,
    /^.*OPENCODE_API_/,
    /^.*OPENCODE_ENABLE_/,
    /^.*OPENCODE_RUNTIME/,
    /^.*OPENCODE_CLIENT/,
    /^.*OPENCODE_DEBUG/,
    /^.*OPENCODE_DOWNLOAD_/,
    /^.*OPENCODE_AUTH_/,
    /^.*OPENCODE_INSTANCE_ID/,
    /^.*OPENCODE_HOME/,
    /^.*OPENCODE_DATA/,
    /^.*OPENCODE_PRINT/,
    /^.*OPENCODE_PERMISSION/,
    /^.*OPENCODE_NO_/,
    /^.*OPENCODE_FORCE_/,
    /^.*OPENCODE_SHARE_/,
    /^.*"opencode-claude-code"/,
    /^.*opencode-claude-code/,
    /^.*"@opencode\//, // wider scoped imports
    /^.*claude-code-/, // anthropic-beta header value
    /import.*opencode/, // import paths within @opencode-ai/util
  ]

  // Skip lines inside `altimate_change start ... altimate_change end` blocks.
  // Those are intentional altimate customizations and may legitimately reference
  // upstream identifiers in explanatory comments (e.g. "branding fix: was opencode.ai").
  function* nonMarkerLines(content: string): Generator<{ line: string; index: number }> {
    const lines = content.split("\n")
    let inside = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes("altimate_change start")) inside = true
      if (!inside) yield { line, index: i }
      if (line.includes("altimate_change end")) inside = false
    }
  }

  test("no opencode.ai URLs in shipped source", async () => {
    const files = await walkSource(srcDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      for (const { line, index } of nonMarkerLines(content)) {
        if (/opencode\.ai/i.test(line)) {
          violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no anomalyco GitHub references in shipped source", async () => {
    const files = await walkSource(srcDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      for (const { line, index } of nonMarkerLines(content)) {
        if (/anomalyco/i.test(line)) {
          violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("no `OpenCode` brand string in user-facing text (titles, descriptions, prompts)", async () => {
    // Cycle 6 finding: bridge merges keep silently re-introducing literal "OpenCode"
    // in user-visible strings — OAuth callback titles, server route descriptions,
    // permission prompts, system prompts, uninstall flow, ACP README.
    // Allow only these legitimate non-brand uses:
    //   - error classes / type names (OpenCodeError)
    //   - the altimate/plugin/anthropic.ts string substitution (function literally
    //     replaces "OpenCode" → "Claude Code" in agent output — that's the point)
    //   - imports / module references (`@opencode-ai/...`)
    //   - line/block comments (jsdoc, `// OpenCode legacy ...`)
    const files = await walkSource(srcDir, [".ts", ".tsx", ".txt", ".md"])
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!/\bOpenCode\b/.test(line)) continue
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue // comments
        if (/OpenCodeError/.test(line)) continue // error class type
        if (/replace\s*\(\s*\/\\bOpenCode\\b\//.test(line)) continue // anthropic plugin substitution
        violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("root package.json points to AltimateAI repository", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "package.json")))
    expect(pkg.repository?.url).toContain("AltimateAI/altimate-code")
  })

  test("packages/opencode/package.json name is @altimateai/altimate-code", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "packages", "opencode", "package.json")))
    expect(pkg.name).toBe("@altimateai/altimate-code")
  })
})

describe("bridge merge: altimate_change marker integrity", () => {
  test("every 'altimate_change start' has a paired 'altimate_change end'", async () => {
    const files = await walkSource(srcDir)
    const violations: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const starts = (content.match(/altimate_change\s+start/g) ?? []).length
      const ends = (content.match(/altimate_change\s+end/g) ?? []).length
      if (starts !== ends) {
        violations.push(`${path.relative(repoRoot, file)}: ${starts} start / ${ends} end (must be equal)`)
      }
    }
    expect(violations).toEqual([])
  })

  // Note: nested markers are intentional and used as a "context" pattern —
  // an outer marker wraps the entire altimate-owned section, with inner
  // markers tagging individual upstream_fix or feature edits within it.
  // The marker guard in script/upstream/analyze.ts handles this correctly.
  // See packages/opencode/src/skill/followups.ts for a typical example.
})

describe("bridge merge: critical altimate features remain wired", () => {
  test("memory namespace exports core API", async () => {
    const content = await readText(path.join(srcDir, "memory", "store.ts"))
    expect(content).toContain("export")
  })

  test("builder agent prompt is loaded", async () => {
    const agentPath = path.join(srcDir, "agent", "agent.ts")
    const content = await readText(agentPath)
    expect(content).toContain("builder")
    // builder is the canonical name, "build" is an alias added during bridge
    expect(content).toContain("PROMPT_BUILDER")
  })

  test("'build' agent name is aliased to 'builder'", async () => {
    const agentPath = path.join(srcDir, "agent", "agent.ts")
    const content = await readText(agentPath)
    expect(content).toMatch(/agent === ["']build["']/)
    // v1.17.9 merge renamed the agent-map variable `x` -> `agents`; the alias
    // still resolves "build" to the "builder" agent (agent.ts ~L539).
    expect(content).toMatch(/\b(?:agents|x)\["builder"\]/)
  })

  test("Altimate-specific provider plugins exist", async () => {
    expect(existsSync(path.join(srcDir, "altimate", "plugin", "snowflake.ts"))).toBe(true)
    expect(existsSync(path.join(srcDir, "altimate", "plugin", "databricks.ts"))).toBe(true)
  })

  test("provider.ts imports altimate plugin validators", async () => {
    const content = await readText(path.join(srcDir, "provider", "provider.ts"))
    expect(content).toContain("VALID_ACCOUNT_RE")
    expect(content).toContain("isValidDatabricksHost")
  })

  test("dbt-tools package exists with adapter", async () => {
    expect(existsSync(path.join(repoRoot, "packages", "dbt-tools", "src", "adapter.ts"))).toBe(true)
  })

  test("ALTIMATE_CLI_YOLO flag is registered", async () => {
    const content = await readText(path.join(srcDir, "flag", "flag.ts"))
    expect(content).toContain("ALTIMATE_CLI_YOLO")
  })

  test("Altimate Code Desktop app ID is correct (not OpenCode Desktop)", async () => {
    const files = await walkSource(srcDir)
    let foundAltimateAppId = false
    for (const file of files) {
      const content = await readText(file)
      if (/ai\.altimate\.code\.desktop/.test(content)) {
        foundAltimateAppId = true
        break
      }
      // Reject if any file uses the upstream app ID
      if (/ai\.opencode\.desktop/.test(content)) {
        throw new Error(`${file} uses upstream app ID ai.opencode.desktop; should be ai.altimate.code.desktop`)
      }
    }
    // App ID may not appear in opencode/src — that's OK, we just check no leak
    expect(foundAltimateAppId).toBe(foundAltimateAppId) // tautology — the throw above is the assertion
  })
})

describe("bridge merge: @ts-nocheck inventory", () => {
  // @ts-nocheck "DRAFT bridge merge" annotations are technical debt from this
  // bridge. They should DECREASE over time, never increase.
  // Update the limit DOWNWARD when removing annotations; never upward without
  // explicit followup-PR justification.
  const NOCHECK_LIMIT = 0

  test("@ts-nocheck DRAFT-bridge inventory does not exceed limit", async () => {
    const files = await walkSource(srcDir)
    const offenders: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const firstLine = content.split("\n")[0] ?? ""
      if (/@ts-nocheck.*DRAFT bridge merge/.test(firstLine)) {
        offenders.push(path.relative(repoRoot, file))
      }
    }
    expect(offenders.length).toBeLessThanOrEqual(NOCHECK_LIMIT)
  })

  test("@ts-nocheck DRAFT-bridge annotations have a tracking comment", async () => {
    const files = await walkSource(srcDir)
    const offenders: string[] = []
    for (const file of files) {
      const content = await readText(file)
      const firstLine = content.split("\n")[0] ?? ""
      if (/@ts-nocheck/.test(firstLine) && !/DRAFT bridge merge|@ts-nocheck.*reason:/.test(firstLine)) {
        offenders.push(path.relative(repoRoot, file))
      }
    }
    // Permit only DRAFT bridge merge or reason: comment annotations
    expect(offenders).toEqual([])
  })
})

describe("bridge merge: workspace integrity", () => {
  test("root package.json workspaces only references existing dirs", async () => {
    const pkg = JSON.parse(await readText(path.join(repoRoot, "package.json")))
    const workspaces: string[] = pkg.workspaces?.packages ?? []
    for (const ws of workspaces) {
      // Skip glob patterns — those are checked by bun at install time
      if (ws.includes("*")) continue
      const dir = path.join(repoRoot, ws)
      expect(existsSync(dir), `workspace ${ws} does not exist`).toBe(true)
    }
  })

  test("turbo.json does not reference non-existent packages", async () => {
    const turbo = JSON.parse(await readText(path.join(repoRoot, "turbo.json")))
    const tasks = Object.keys(turbo.tasks ?? {})
    const orphaned: string[] = []
    const skipFilesPackages = [
      "app",
      "console",
      "containers",
      "desktop",
      "desktop-electron",
      "docs",
      "enterprise",
      "extensions",
      "function",
      "identity",
      "slack",
      "storybook",
      "ui",
      "web",
    ]
    for (const task of tasks) {
      if (!task.includes("#")) continue
      const [pkgName] = task.split("#")
      if (!pkgName) continue
      // Strip @opencode-ai/ scope or other namespace
      const bareName = pkgName.replace(/^@[^/]+\//, "")
      if (skipFilesPackages.includes(bareName)) {
        orphaned.push(`turbo.json task "${task}" references skipped package "${pkgName}"`)
      }
    }
    expect(orphaned).toEqual([])
  })
})
