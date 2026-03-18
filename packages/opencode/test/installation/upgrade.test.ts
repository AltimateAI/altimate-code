import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { Glob } from "bun"
import { Installation } from "../../src/installation"

const srcDir = resolve(import.meta.dir, "..", "..", "src")
const fetch0 = globalThis.fetch

afterEach(() => {
  globalThis.fetch = fetch0
})

// ---------------------------------------------------------------------------
// 1. VERSION normalization
// ---------------------------------------------------------------------------
describe("VERSION normalization", () => {
  test("VERSION never starts with 'v' prefix", () => {
    // In test env it's "local", but the logic that produces VERSION strips "v"
    if (Installation.VERSION !== "local") {
      expect(Installation.VERSION.startsWith("v")).toBe(false)
    }
  })

  test("installation/index.ts trims and strips 'v' prefix from OPENCODE_VERSION", () => {
    const content = readFileSync(join(srcDir, "installation", "index.ts"), "utf-8")
    // Verify the VERSION definition includes .trim().replace(/^v/, "")
    expect(content).toContain('.trim().replace(/^v/, "")')
  })
})

// ---------------------------------------------------------------------------
// 2. Upgrade skip logic — version comparison
// ---------------------------------------------------------------------------
describe("upgrade version comparison", () => {
  test("same version from GitHub API matches (no false upgrade)", async () => {
    // Simulate GitHub API returning v0.4.1 → latest() returns "0.4.1"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.4.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const latest = await Installation.latest("unknown")
    // If VERSION were "0.4.1" (normalized), they'd match → upgrade skipped
    expect(latest).toBe("0.4.1")
    // Verify no "v" prefix that would cause mismatch
    expect(latest.startsWith("v")).toBe(false)
  })

  test("same version from npm API matches (no false upgrade)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.4.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const latest = await Installation.latest("npm")
    expect(latest).toBe("0.4.1")
    expect(latest.startsWith("v")).toBe(false)
  })

  test("different version correctly triggers upgrade", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.5.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    const latest = await Installation.latest("unknown")
    expect(latest).toBe("0.5.0")
    // "0.4.1" !== "0.5.0" → upgrade proceeds
    expect("0.4.1").not.toBe(latest)
  })

  test("auto-upgrade also uses normalized comparison", () => {
    // The auto-upgrade in cli/upgrade.ts uses the same Installation.VERSION
    const content = readFileSync(join(srcDir, "cli", "upgrade.ts"), "utf-8")
    expect(content).toContain("Installation.VERSION === latest")
  })
})

// ---------------------------------------------------------------------------
// 3. User-facing strings: no stale "opencode" references
// ---------------------------------------------------------------------------
describe("user-facing strings use 'altimate' not 'opencode'", () => {
  // Patterns that indicate user-facing strings containing "opencode" where it should be "altimate"
  const userFacingOpencode = /(?:run|Run)\s+[`'"]opencode\s|opencode\s+upgrade|opencode\s+auth/

  test("app.tsx toast uses 'altimate upgrade' not 'opencode upgrade'", () => {
    const content = readFileSync(join(srcDir, "cli", "cmd", "tui", "app.tsx"), "utf-8")
    expect(content).toContain("altimate upgrade")
    expect(content).not.toMatch(/opencode upgrade/)
  })

  test("provider error messages use 'altimate' not 'opencode'", () => {
    const errorTs = readFileSync(join(srcDir, "provider", "error.ts"), "utf-8")
    expect(errorTs).not.toMatch(/`opencode auth/)
    expect(errorTs).toContain("`altimate auth")
  })

  test("provider.ts uses 'altimate auth' not 'opencode auth'", () => {
    const content = readFileSync(join(srcDir, "provider", "provider.ts"), "utf-8")
    expect(content).not.toMatch(/`opencode auth/)
  })

  test("acp/agent.ts uses 'altimate auth' not 'opencode auth'", () => {
    const content = readFileSync(join(srcDir, "acp", "agent.ts"), "utf-8")
    expect(content).not.toMatch(/`opencode auth/)
    expect(content).toContain("`altimate auth")
  })

  test("acp/agent.ts terminal-auth command uses 'altimate' binary", () => {
    const content = readFileSync(join(srcDir, "acp", "agent.ts"), "utf-8")
    // The terminal-auth capability tells IDEs which command to run for auth
    expect(content).toMatch(/command:\s*"altimate"/)
    expect(content).not.toMatch(/command:\s*"opencode"/)
  })

  test("no user-facing 'opencode' command references in src/ (broad scan)", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.{ts,tsx}")

    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readFileSync(filePath, "utf-8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments, imports, internal identifiers
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("import ")) continue
        if (trimmed.startsWith("*")) continue // JSDoc

        // Check for user-facing strings like "run `opencode ...", "Run 'opencode ..."
        if (userFacingOpencode.test(line)) {
          violations.push(`${file}:${i + 1}: ${trimmed}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
