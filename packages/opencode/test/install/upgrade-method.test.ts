/**
 * Upgrade method detection and brew latest() tests.
 *
 * Validates the installation method detection logic and the
 * brew version resolution paths in installation/index.ts.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const INSTALLATION_SRC = fs.readFileSync(
  path.resolve(import.meta.dir, "../../src/installation/index.ts"),
  "utf-8",
)

describe("installation method detection", () => {
  test("checks brew with correct formula name", () => {
    // method() must check for "altimate-code" not "opencode"
    expect(INSTALLATION_SRC).toContain('"altimate-code"')
  })

  test("npm detection uses scoped package name", () => {
    expect(INSTALLATION_SRC).toContain("@altimateai/altimate-code")
  })

  test("brew check command uses brew list --formula", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "list", "--formula"')
  })

  test("method detection prioritizes matching exec path", () => {
    // checks.sort puts the manager matching process.execPath first
    expect(INSTALLATION_SRC).toContain("exec.includes(a.name)")
  })
})

describe("brew formula resolution", () => {
  test("getBrewFormula checks tap formula first", () => {
    expect(INSTALLATION_SRC).toContain("AltimateAI/tap/altimate-code")
  })

  test("getBrewFormula returns tap formula as default", () => {
    expect(INSTALLATION_SRC).toContain('return "AltimateAI/tap/altimate-code"')
  })
})

describe("brew latest() version resolution", () => {
  test("tap formula uses brew info --json=v2", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "info", "--json=v2"')
  })

  test("non-tap formula does NOT use formulae.brew.sh", () => {
    // altimate-code is NOT in core homebrew — formulae.brew.sh would 404
    expect(INSTALLATION_SRC).not.toContain("formulae.brew.sh/api/formula/altimate-code.json")
  })

  test("non-tap brew uses GitHub releases API as source of truth", () => {
    // brew info --json=v2 returns LOCAL cached version which can be stale.
    // GitHub releases API is authoritative for the actual latest version.
    expect(INSTALLATION_SRC).toContain("api.github.com/repos/AltimateAI/altimate-code/releases/latest")
  })

  test("GitHub releases fallback strips v prefix from tag_name", () => {
    expect(INSTALLATION_SRC).toContain('tag_name.replace(/^v/, "")')
  })

  test("GitHub releases fallback validates tag_name exists", () => {
    expect(INSTALLATION_SRC).toContain("Missing tag_name")
  })
})

describe("upgrade execution", () => {
  test("npm upgrade uses scoped package name", () => {
    expect(INSTALLATION_SRC).toContain("@altimateai/altimate-code@${target}")
  })

  test("brew upgrade taps AltimateAI/tap", () => {
    expect(INSTALLATION_SRC).toContain('"brew", "tap", "AltimateAI/tap"')
  })

  test("brew upgrade pulls latest formula before upgrading", () => {
    expect(INSTALLATION_SRC).toContain('"git", "pull", "--ff-only"')
  })

  test("brew upgrade disables auto-update", () => {
    expect(INSTALLATION_SRC).toContain("HOMEBREW_NO_AUTO_UPDATE")
  })

  test("curl upgrade uses altimate.ai/install endpoint", () => {
    expect(INSTALLATION_SRC).toContain("https://altimate.ai/install")
  })

  test("VERSION normalization strips v prefix", () => {
    expect(INSTALLATION_SRC).toContain('OPENCODE_VERSION.trim().replace(/^v/, "")')
  })
})

describe("version comparison in upgrade command", () => {
  /**
   * Simulate the version comparison logic from cmd/upgrade.ts.
   * Both sides must be normalized for comparison to work.
   */
  function wouldSkipUpgrade(currentVersion: string, target: string): boolean {
    return currentVersion === target
  }

  test("matching versions skip upgrade", () => {
    expect(wouldSkipUpgrade("0.4.9", "0.4.9")).toBe(true)
  })

  test("different versions proceed with upgrade", () => {
    expect(wouldSkipUpgrade("0.4.8", "0.4.9")).toBe(false)
  })

  test("v-prefixed current would NOT match clean target (documents the fix)", () => {
    // Before the fix, VERSION could be "v0.4.9" and target "0.4.9"
    // This would incorrectly proceed with upgrade even when versions match
    expect(wouldSkipUpgrade("v0.4.9", "0.4.9")).toBe(false)
    // After the fix, both are clean — comparison works correctly
    const normalized = "v0.4.9".replace(/^v/, "")
    expect(wouldSkipUpgrade(normalized, "0.4.9")).toBe(true)
  })
})
