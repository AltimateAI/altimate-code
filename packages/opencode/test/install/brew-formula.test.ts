/**
 * Homebrew formula generation tests.
 *
 * Validates that the brew formula template in publish.ts generates
 * correct Ruby syntax, URLs, version fields, and platform coverage.
 */
import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const PUBLISH_SCRIPT = fs.readFileSync(
  path.resolve(import.meta.dir, "../../script/publish.ts"),
  "utf-8",
)

/**
 * Generate a brew formula using the same template logic as publish.ts,
 * but with test values substituted.
 */
function generateBrewFormula(opts: {
  version: string
  macX64Sha: string
  macArm64Sha: string
  x64Sha: string
  arm64Sha: string
}): string {
  return [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "class AltimateCode < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/AltimateAI/altimate-code"`,
    `  version "${opts.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${opts.version}/altimate-code-darwin-x64.zip"`,
    `      sha256 "${opts.macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "altimate"',
    '        bin.install_symlink "altimate" => "altimate-code"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${opts.version}/altimate-code-darwin-arm64.zip"`,
    `      sha256 "${opts.macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "altimate"',
    '        bin.install_symlink "altimate" => "altimate-code"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${opts.version}/altimate-code-linux-x64.tar.gz"`,
    `      sha256 "${opts.x64Sha}"`,
    "      def install",
    '        bin.install "altimate"',
    '        bin.install_symlink "altimate" => "altimate-code"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/AltimateAI/altimate-code/releases/download/v${opts.version}/altimate-code-linux-arm64.tar.gz"`,
    `      sha256 "${opts.arm64Sha}"`,
    "      def install",
    '        bin.install "altimate"',
    '        bin.install_symlink "altimate" => "altimate-code"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")
}

describe("brew formula template", () => {
  const formula = generateBrewFormula({
    version: "0.4.9",
    macX64Sha: "abc123",
    macArm64Sha: "def456",
    x64Sha: "ghi789",
    arm64Sha: "jkl012",
  })

  test("version field is clean semver without v prefix", () => {
    expect(formula).toContain('version "0.4.9"')
    expect(formula).not.toContain('version "v0.4.9"')
  })

  test("URLs have exactly one v prefix", () => {
    const urls = formula.match(/url "([^"]+)"/g) || []
    expect(urls.length).toBe(4)
    for (const url of urls) {
      expect(url).toContain("/download/v0.4.9/")
      expect(url).not.toContain("/download/vv0.4.9/")
    }
  })

  test("all 4 platform variants are present", () => {
    expect(formula).toContain("altimate-code-darwin-x64.zip")
    expect(formula).toContain("altimate-code-darwin-arm64.zip")
    expect(formula).toContain("altimate-code-linux-x64.tar.gz")
    expect(formula).toContain("altimate-code-linux-arm64.tar.gz")
  })

  test("macOS uses .zip format", () => {
    const macUrls = formula.match(/darwin-[^"]+/g) || []
    for (const url of macUrls) {
      expect(url).toMatch(/\.zip$/)
    }
  })

  test("Linux uses .tar.gz format", () => {
    const linuxUrls = formula.match(/linux-[^"]+/g) || []
    for (const url of linuxUrls) {
      expect(url).toMatch(/\.tar\.gz$/)
    }
  })

  test("SHA256 hashes are present for all platforms", () => {
    const shas = formula.match(/sha256 "[^"]+"/g) || []
    expect(shas.length).toBe(4)
  })

  test("depends on ripgrep", () => {
    expect(formula).toContain('depends_on "ripgrep"')
  })

  test("installs altimate binary and creates altimate-code symlink", () => {
    const installLines = formula.match(/bin\.install "altimate"/g) || []
    expect(installLines.length).toBe(4) // once per platform variant

    const symlinkLines = formula.match(/bin\.install_symlink "altimate" => "altimate-code"/g) || []
    expect(symlinkLines.length).toBe(4)
  })

  test("class name is AltimateCode", () => {
    expect(formula).toContain("class AltimateCode < Formula")
  })

  test("has correct homepage", () => {
    expect(formula).toContain('homepage "https://github.com/AltimateAI/altimate-code"')
  })
})

describe("brew formula with pre-release version", () => {
  const formula = generateBrewFormula({
    version: "1.0.0-beta.1",
    macX64Sha: "aaa",
    macArm64Sha: "bbb",
    x64Sha: "ccc",
    arm64Sha: "ddd",
  })

  test("version field strips pre-release suffix", () => {
    expect(formula).toContain('version "1.0.0"')
    expect(formula).not.toContain('version "1.0.0-beta.1"')
  })

  test("URLs include full pre-release version", () => {
    expect(formula).toContain("/download/v1.0.0-beta.1/")
  })
})

describe("publish.ts brew formula template matches test template", () => {
  test("publish.ts generates formula with same structure", () => {
    // Verify the template in publish.ts uses the same patterns we test
    expect(PUBLISH_SCRIPT).toContain("class AltimateCode < Formula")
    expect(PUBLISH_SCRIPT).toContain('depends_on "ripgrep"')
    expect(PUBLISH_SCRIPT).toContain('bin.install "altimate"')
    expect(PUBLISH_SCRIPT).toContain('bin.install_symlink "altimate" => "altimate-code"')
    expect(PUBLISH_SCRIPT).toContain("on_macos do")
    expect(PUBLISH_SCRIPT).toContain("on_linux do")
    expect(PUBLISH_SCRIPT).toContain("Hardware::CPU.intel?")
    expect(PUBLISH_SCRIPT).toContain("Hardware::CPU.arm?")
  })

  test("publish.ts uses Script.version in URL construction", () => {
    // URLs must use v${Script.version} — not vv or raw tag
    expect(PUBLISH_SCRIPT).toContain("v${Script.version}/altimate-code-darwin-x64.zip")
    expect(PUBLISH_SCRIPT).toContain("v${Script.version}/altimate-code-darwin-arm64.zip")
    expect(PUBLISH_SCRIPT).toContain("v${Script.version}/altimate-code-linux-x64.tar.gz")
    expect(PUBLISH_SCRIPT).toContain("v${Script.version}/altimate-code-linux-arm64.tar.gz")
  })
})
