/**
 * Version normalization tests.
 *
 * Ensures that version strings are consistently normalized throughout the
 * publish pipeline — no double-v prefixes, no v-prefixed semver in package.json
 * fields, and correct URL construction for release assets.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const PUBLISH_SCRIPT = fs.readFileSync(
  path.resolve(import.meta.dir, "../../script/publish.ts"),
  "utf-8",
)

const SCRIPT_INDEX = fs.readFileSync(
  path.resolve(import.meta.dir, "../../../../packages/script/src/index.ts"),
  "utf-8",
)

describe("Script.version normalization", () => {
  test("strips v prefix from OPENCODE_VERSION env var", () => {
    // The source of truth: packages/script/src/index.ts
    // Must strip v prefix so all downstream consumers get clean semver
    expect(SCRIPT_INDEX).toContain('env.OPENCODE_VERSION.replace(/^v/, "")')
  })

  test("channel detection strips v prefix before 0.0.0- check", () => {
    // v0.0.0-preview tags should NOT be treated as "latest" channel
    expect(SCRIPT_INDEX).toContain('env.OPENCODE_VERSION.replace(/^v/, "").startsWith("0.0.0-")')
  })

  test("Installation.VERSION also strips v prefix", () => {
    const installationSrc = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/installation/index.ts"),
      "utf-8",
    )
    expect(installationSrc).toContain('OPENCODE_VERSION.trim().replace(/^v/, "")')
  })
})

describe("publish.ts URL construction", () => {
  test("brew formula URLs use v${Script.version} pattern (single v prefix)", () => {
    // The publish script generates URLs like:
    //   https://github.com/.../releases/download/v${Script.version}/altimate-code-darwin-arm64.zip
    // Script.version is already stripped of v, so this produces v0.4.9 (correct)
    const urlPattern = /releases\/download\/v\$\{Script\.version\}/g
    const matches = PUBLISH_SCRIPT.match(urlPattern) || []
    expect(matches.length).toBeGreaterThanOrEqual(4) // 4 platform URLs in brew formula

    // Must NOT have vv (double-v) anywhere
    expect(PUBLISH_SCRIPT).not.toContain("download/vv")
    expect(PUBLISH_SCRIPT).not.toContain('download/v${Script.version.replace')
  })

  test("AUR PKGBUILD URLs use v${} pattern (single v prefix)", () => {
    // AUR uses: https://github.com/.../releases/download/v${pkgver}${_subver}/...
    // pkgver comes from Script.version which is already clean
    expect(PUBLISH_SCRIPT).toContain("download/v\\${pkgver}\\${_subver}/")
  })

  test("brew formula version field does not include v prefix", () => {
    // The formula version line: version "${Script.version.split("-")[0]}"
    // Script.version is already clean (e.g., "0.4.9"), so this produces: version "0.4.9"
    expect(PUBLISH_SCRIPT).toContain('version "${Script.version.split("-")[0]}"')
  })

  test("docker tags use clean version", () => {
    // Docker tags: ${image}:${version} where version = Script.version (clean)
    expect(PUBLISH_SCRIPT).toContain("`${image}:${version}`")
    expect(PUBLISH_SCRIPT).toContain("`${image}:${Script.channel}`")
  })
})

describe("version format validation", () => {
  /**
   * Simulate what Script.version produces for various OPENCODE_VERSION inputs.
   * This tests the normalization logic in isolation.
   */
  function normalizeVersion(input: string): string {
    return input.replace(/^v/, "")
  }

  test("strips v prefix from tagged version", () => {
    expect(normalizeVersion("v0.4.9")).toBe("0.4.9")
  })

  test("preserves clean version", () => {
    expect(normalizeVersion("0.4.9")).toBe("0.4.9")
  })

  test("handles pre-release tags", () => {
    expect(normalizeVersion("v1.0.0-beta.1")).toBe("1.0.0-beta.1")
  })

  test("handles version without minor/patch", () => {
    expect(normalizeVersion("v1")).toBe("1")
  })

  test("does not strip v from middle of string", () => {
    expect(normalizeVersion("0.4.9-dev")).toBe("0.4.9-dev")
  })

  /**
   * Simulate the brew formula URL construction to verify no double-v.
   */
  function brewFormulaUrl(version: string, platform: string): string {
    // Matches publish.ts pattern exactly
    return `https://github.com/AltimateAI/altimate-code/releases/download/v${version}/altimate-code-${platform}.zip`
  }

  test("brew URL from git tag v0.4.9 has single v prefix", () => {
    const version = normalizeVersion("v0.4.9")
    const url = brewFormulaUrl(version, "darwin-arm64")
    expect(url).toBe(
      "https://github.com/AltimateAI/altimate-code/releases/download/v0.4.9/altimate-code-darwin-arm64.zip",
    )
    expect(url).not.toContain("vv")
  })

  test("brew URL from clean version 0.4.9 has single v prefix", () => {
    const version = normalizeVersion("0.4.9")
    const url = brewFormulaUrl(version, "darwin-x64")
    expect(url).toBe(
      "https://github.com/AltimateAI/altimate-code/releases/download/v0.4.9/altimate-code-darwin-x64.zip",
    )
  })

  test("brew formula version field is clean semver", () => {
    const version = normalizeVersion("v0.4.9")
    const formulaVersion = version.split("-")[0]
    expect(formulaVersion).toBe("0.4.9")
    expect(formulaVersion).not.toMatch(/^v/)
  })

  test("AUR pkgver split from pre-release is clean", () => {
    const version = normalizeVersion("v1.2.3-beta.1")
    const [pkgver, _subver = ""] = version.split(/(-.*)/, 2)
    expect(pkgver).toBe("1.2.3")
    expect(_subver).toBe("-beta.1")
  })

  test("npm optionalDependencies version is valid semver", () => {
    const version = normalizeVersion("v0.4.9")
    // npm requires valid semver — no v prefix
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(version).not.toMatch(/^v/)
  })
})
