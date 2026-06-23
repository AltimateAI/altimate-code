/**
 * Windows standalone installer (install.ps1) + native-Windows upgrade wiring.
 *
 * Pins the parity contract with the bash installer: the PowerShell script must
 * pull the Bun-compiled altimate.exe from GitHub releases (NOT npm), share the
 * altimate.sh/install.ps1 host with the in-app upgrade path, and the upgrade
 * "curl" branch must route native Windows through PowerShell (there is no bash).
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const INSTALLATION_SRC = readFileSync(join(REPO_ROOT, "packages/opencode/src/installation/index.ts"), "utf-8")
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf-8")
const WINDOWS_DOC = readFileSync(join(REPO_ROOT, "docs/docs/reference/windows-wsl.md"), "utf-8")

describe("install.ps1 — Bun exe, not npm", () => {
  test("downloads from GitHub releases and extracts the binary, not npm", () => {
    expect(PS1).toContain("github.com/AltimateAI/altimate-code/releases")
    expect(PS1).toContain("Expand-Archive")
    // npm only appears as an ARM64 fallback hint, never as the install mechanism.
    expect(PS1).not.toContain("npm install -g @altimateai")
  })

  test("installs the .exe into .altimate\\bin", () => {
    expect(PS1).toContain(".altimate\\bin")
    expect(PS1).toContain('"$App.exe"')
  })

  test("rejects win32-arm64 (no NAPI prebuild)", () => {
    expect(PS1).toContain("Unsupported OS/Arch")
  })

  test("resolves arch via PROCESSOR_ARCHITEW6432 (WOW64-safe)", () => {
    // A 32-bit PowerShell host on 64-bit Windows reports PROCESSOR_ARCHITECTURE=x86;
    // the real arch is in PROCESSOR_ARCHITEW6432. Must prefer the latter.
    expect(PS1).toContain("PROCESSOR_ARCHITEW6432")
  })

  test("exposes a -Help/usage block", () => {
    expect(PS1).toContain("[switch]$Help")
    expect(PS1).toContain("Altimate Code Installer")
  })
})

describe("install.ps1 — baseline (non-AVX2) parity", () => {
  test("detects AVX2 via IsProcessorFeaturePresent(40)", () => {
    expect(PS1).toContain("IsProcessorFeaturePresent(40)")
  })

  test("falls back to the windows-x64-baseline archive", () => {
    expect(PS1).toContain("windows-$arch")
    expect(PS1).toContain("$target-baseline")
  })

  test("retries the baseline build on STATUS_ILLEGAL_INSTRUCTION", () => {
    expect(PS1).toContain("3221225501")
  })
})

describe("install.ps1 — host consistency with the upgrade path", () => {
  test("source upgrade URL uses (www.)altimate.sh/install.ps1", () => {
    expect(INSTALLATION_SRC).toMatch(
      /UPGRADE_INSTALL_PS_URL\s*=\s*"https:\/\/(www\.)?altimate\.sh\/install\.ps1"/,
    )
  })

  test("README and Windows docs advertise the install.ps1 one-liner", () => {
    expect(README).toContain("altimate.sh/install.ps1")
    expect(WINDOWS_DOC).toContain("altimate.sh/install.ps1")
  })
})

describe("upgrade() — native Windows routes through PowerShell", () => {
  test("upgradePowershell exists and runs the PS installer", () => {
    expect(INSTALLATION_SRC).toContain("async function upgradePowershell")
    expect(INSTALLATION_SRC).toMatch(/irm \$\{UPGRADE_INSTALL_PS_URL\} \| iex/)
  })

  test("curl branch dispatches on win32", () => {
    expect(INSTALLATION_SRC).toMatch(/process\.platform === "win32"\s*\?\s*await upgradePowershell\(target\)/)
  })
})
