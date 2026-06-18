import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const INSTALL_PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const INSTALLATION_TS = readFileSync(join(REPO_ROOT, "packages/opencode/src/installation/index.ts"), "utf-8")

function scriptBlock(start: string, end: string) {
  const startIndex = INSTALL_PS1.indexOf(start)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  const endIndex = INSTALL_PS1.indexOf(end, startIndex)
  expect(endIndex).toBeGreaterThan(startIndex)
  return INSTALL_PS1.slice(startIndex, endIndex)
}

function upgradePowershellBlock() {
  const startIndex = INSTALLATION_TS.indexOf("async function upgradePowershell")
  expect(startIndex).toBeGreaterThanOrEqual(0)
  const endIndex = INSTALLATION_TS.indexOf("// altimate_change end", startIndex)
  expect(endIndex).toBeGreaterThan(startIndex)
  return INSTALLATION_TS.slice(startIndex, endIndex)
}

describe("PR #930 install.ps1 release URL construction", () => {
  test("uses only HTTPS GitHub release URLs for Windows zip assets", () => {
    // The archive and checksums.txt share one $base so they always resolve to the
    // same release (see verify_checksum / Test-Checksum). $base is the latest
    // download path or the pinned release tag; $url and $checksumsUrl derive from it.
    expect(INSTALL_PS1).toContain('$base = "https://github.com/AltimateAI/altimate-code/releases/latest/download"')
    expect(INSTALL_PS1).toContain('$base = "https://github.com/AltimateAI/altimate-code/releases/download/v$specificVersion"')
    expect(INSTALL_PS1).toContain('$url = "$base/$filename"')
    expect(INSTALL_PS1).toContain('"https://api.github.com/repos/AltimateAI/altimate-code/releases/latest"')
    expect(INSTALL_PS1).not.toMatch(/http:\/\/(?:github\.com|api\.github\.com|www\.altimate\.sh)/)
  })

  test("builds the release asset name from fixed app and Windows target pieces", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain('$target = "windows-$arch"')
    expect(installTarget).toContain('if ($Baseline) { $target = "$target-baseline" }')
    expect(installTarget).toContain('$filename = "$App-$target.zip"')
    expect(INSTALL_PS1).toContain('$App = "altimate"')
    expect(INSTALL_PS1).toContain('$arch = "x64"')
    expect(installTarget).not.toMatch(/\$filename\s*=.*\$Version/)
    expect(installTarget).not.toMatch(/\$filename\s*=.*\$specificVersion/)
  })

  test("normalizes pinned versions and probes the release tag before downloading", () => {
    const versionBlock = scriptBlock("# Resolve version (once)", "# Skip if the requested version")
    expect(versionBlock).toContain("$Version = $Version -replace '^v', ''")
    expect(versionBlock).toContain('$specificVersion = $Version')
    expect(versionBlock).toContain('"https://github.com/AltimateAI/altimate-code/releases/tag/v$Version"')
    expect(versionBlock).toContain("-Method Head")
    expect(versionBlock).toContain("Release v$Version not found")
    expect(versionBlock).toContain("exit 1")
  })

  test("latest-version resolution requires a nonblank GitHub release tag", () => {
    const versionBlock = scriptBlock("# Resolve version (once)", "# Skip if the requested version")
    expect(versionBlock).toContain("[string]::IsNullOrWhiteSpace($Version)")
    expect(versionBlock).toContain('"User-Agent" = "altimate-install"')
    expect(versionBlock).toContain("$specificVersion = ($rel.tag_name -replace '^v', '')")
    expect(versionBlock).toContain("[string]::IsNullOrWhiteSpace($specificVersion)")
    expect(versionBlock.match(/Failed to fetch version information/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe("PR #930 install.ps1 download and archive safety", () => {
  test("verifies downloaded archive integrity with SHA256 before extraction", () => {
    // Closed by the checksum-verification work: Test-Checksum fetches checksums.txt
    // and compares SHA256, and the verify call precedes the actual extraction.
    expect(INSTALL_PS1).toContain("Test-Checksum -Path $zipPath")
    expect(INSTALL_PS1).toContain("Get-FileHash -Path $Path -Algorithm SHA256")
    expect(INSTALL_PS1.indexOf("Test-Checksum -Path")).toBeLessThan(INSTALL_PS1.indexOf("Expand-Archive -Path"))
  })

  test("fails curl.exe downloads on HTTP errors and checks curl exit status", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain("Get-Command curl.exe -ErrorAction SilentlyContinue")
    expect(installTarget).toContain('& $curl.Source "-#SfLo" $zipPath $url')
    expect(installTarget).toContain('$LASTEXITCODE -ne 0')
    expect(installTarget).toContain('throw "curl.exe failed downloading $url (exit $LASTEXITCODE)"')
  })

  test("falls back to Invoke-WebRequest with an explicit output file", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain("Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing")
    expect(installTarget).not.toMatch(/Invoke-Expression|iex/i)
  })

  test("extracts only from a per-process temp directory and cleans it in finally", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain('Join-Path ([System.IO.Path]::GetTempPath()) "altimate_install_$PID"')
    expect(installTarget).toContain("New-Item -ItemType Directory -Force -Path $tmpDir")
    expect(installTarget).toContain("} finally {")
    expect(installTarget).toContain("Remove-Item -Recurse -Force -Path $tmpDir -ErrorAction SilentlyContinue")
  })

  test("requires the extracted archive to contain the expected executable name", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain("$extracted = Join-Path $tmpDir $BinaryName")
    expect(installTarget).toContain("if (-not (Test-Path $extracted))")
    expect(installTarget).toContain('throw "Archive did not contain $BinaryName"')
    expect(installTarget).toContain("Move-Item -Force -Path $extracted -Destination $InstalledBinary")
  })
})

describe("PR #930 install.ps1 error handling and idempotency", () => {
  test("sets terminating error behavior and wraps network probes in try/catch", () => {
    expect(INSTALL_PS1).toContain('$ErrorActionPreference = "Stop"')
    expect(INSTALL_PS1.match(/\btry\s*\{/g)?.length).toBeGreaterThanOrEqual(4)
    expect(INSTALL_PS1.match(/\bcatch\s*\{/g)?.length).toBeGreaterThanOrEqual(4)
    expect(INSTALL_PS1.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(3)
  })

  test("skips reinstall when altimate or altimate-code already reports the target version", () => {
    const idempotencyBlock = scriptBlock("# Skip if the requested version is already installed", "# Download + extract")
    expect(idempotencyBlock).toContain('@("altimate", "altimate-code")')
    expect(idempotencyBlock).toContain("Get-Command $name -ErrorAction SilentlyContinue")
    expect(idempotencyBlock).toContain("& $probe --version")
    expect(idempotencyBlock).toContain("$installedVersion -eq $specificVersion")
    expect(idempotencyBlock).toContain("exit 0")
  })

  test("updates a locked executable by moving the old binary aside before replacement", () => {
    const installTarget = scriptBlock("function Install-Target", "$needsBaseline")
    expect(installTarget).toContain("if (Test-Path $InstalledBinary)")
    expect(installTarget).toContain('$stale = "$InstalledBinary.old"')
    expect(installTarget).toContain("Move-Item -Force -Path $InstalledBinary -Destination $stale")
    expect(installTarget).toContain('Remove-Item -Force "$InstalledBinary.old" -ErrorAction SilentlyContinue')
  })

  test("does not expose common secret-bearing environment variables or literals", () => {
    expect(INSTALL_PS1).not.toMatch(/\$env:(?:GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY)\b/)
    expect(INSTALL_PS1).not.toMatch(/(?:password|passwd|secret|token|api[_-]?key)\s*=\s*["'][^"']{8,}["']/i)
    expect(INSTALL_PS1).not.toMatch(/-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/)
  })
})

describe("PR #930 install.ps1 PATH manipulation safety", () => {
  test("writes user PATH through the registry instead of setx", () => {
    const pathBlock = scriptBlock("# PATH (user scope", "# GitHub Actions")
    expect(pathBlock).toContain('[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)')
    expect(pathBlock).toContain('[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames')
    expect(pathBlock).toContain('[Microsoft.Win32.RegistryValueKind]::ExpandString')
    expect(pathBlock).not.toMatch(/^\s*setx\b/im)
  })

  test("prepends the install directory only when it is not already present", () => {
    const pathBlock = scriptBlock("# PATH (user scope", "# GitHub Actions")
    expect(pathBlock).toContain("$entries = @($userPath -split ';' | Where-Object { $_ -ne \"\" })")
    expect(pathBlock).toContain("if ($entries -notcontains $InstallDir)")
    expect(pathBlock).toContain("$newPath = (@($InstallDir) + $entries) -join ';'")
    expect(pathBlock).toContain('$env:Path = "$InstallDir;$env:Path"')
  })

  test("honors -NoPathUpdate and gives the manual install directory instead", () => {
    const pathBlock = scriptBlock("# PATH (user scope", "# GitHub Actions")
    expect(pathBlock).toContain("if (-not $NoPathUpdate)")
    expect(pathBlock).toContain('Write-Muted "Skipped PATH modification (--no-modify-path). Add manually: $InstallDir"')
  })

  test("broadcasts environment changes with a bounded timeout after PATH edits", () => {
    const pathBlock = scriptBlock("# PATH (user scope", "# GitHub Actions")
    expect(pathBlock).toContain("function Publish-EnvChange")
    expect(pathBlock).toContain("$WM_SETTINGCHANGE = 0x1a")
    expect(pathBlock).toContain('"Environment", 2, 5000')
    expect(pathBlock).toContain("Publish-EnvChange")
  })
})

describe("PR #930 installation/index.ts Windows upgrade wiring", () => {
  test("probes install.ps1 with HEAD and a bounded timeout before invoking PowerShell", () => {
    const upgradeBlock = upgradePowershellBlock()
    expect(INSTALLATION_TS).toContain('const UPGRADE_INSTALL_PS_URL = "https://www.altimate.sh/install.ps1"')
    expect(INSTALLATION_TS).toContain("const UPGRADE_FETCH_TIMEOUT_MS = 15_000")
    expect(upgradeBlock).toContain('method: "HEAD"')
    expect(upgradeBlock).toContain("AbortSignal.timeout(UPGRADE_FETCH_TIMEOUT_MS)")
    expect(upgradeBlock).toContain("if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)")
  })

  test("passes the target version through env VERSION and avoids npm/node for win32 curl upgrades", () => {
    const upgradeBlock = upgradePowershellBlock()
    expect(upgradeBlock).toContain('["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"')
    expect(upgradeBlock).toContain("VERSION: target")
    expect(upgradeBlock).toContain("nothrow: true")
    expect(upgradeBlock).not.toMatch(/\bnpm\b|\bnode\b/)
  })

  test("includes a manual recovery message that does not leak environment data", () => {
    const upgradeBlock = upgradePowershellBlock()
    const errorMessage = upgradeBlock.slice(
      upgradeBlock.indexOf("throw new Error("),
      upgradeBlock.indexOf("return Process.run"),
    )
    expect(upgradeBlock).toContain("Could not download install script from ${UPGRADE_INSTALL_PS_URL}")
    expect(upgradeBlock).toContain('powershell -c "irm ${UPGRADE_INSTALL_PS_URL} | iex"')
    expect(upgradeBlock).toContain("https://github.com/AltimateAI/altimate-code/releases/latest")
    expect(errorMessage).not.toMatch(/process\.env|OPENAI_API_KEY|GITHUB_TOKEN|NPM_TOKEN/)
  })
})
