#!/usr/bin/env pwsh
# Altimate Code installer for Windows (PowerShell).
#
# Mirrors ./install (the bash installer for macOS/Linux): it downloads the
# Bun-compiled standalone executable (altimate.exe) from GitHub releases and
# drops it in %USERPROFILE%\.altimate\bin - it does NOT depend on npm/Node.
#
# Usage:
#   powershell -c "irm https://www.altimate.sh/install.ps1 | iex"
#   # pin a version / skip PATH edit / force the baseline (non-AVX2) build:
#   &([scriptblock]::Create((irm https://www.altimate.sh/install.ps1))) -Version 1.0.180
#   &([scriptblock]::Create((irm https://www.altimate.sh/install.ps1))) -NoPathUpdate
#   &([scriptblock]::Create((irm https://www.altimate.sh/install.ps1))) -ForceBaseline

param(
  # Install a specific version (e.g. 1.0.180). Falls back to $env:VERSION so the
  # in-app `altimate upgrade` flow can pin the target version.
  [string]$Version = $env:VERSION,
  # Don't modify the user PATH (mirrors --no-modify-path).
  [switch]$NoPathUpdate = $false,
  # Force the baseline (non-AVX2) build even if AVX2 is detected. Also used by
  # the illegal-instruction retry below when AVX2 detection is wrong.
  [switch]$ForceBaseline = $false,
  # Show usage and exit (mirrors -h/--help in the bash installer).
  [switch]$Help = $false
)

$ErrorActionPreference = "Stop"
# Expand-Archive / Invoke-WebRequest render a slow progress UI over a remote
# stream; silence it so piped installs stay fast and clean.
$ProgressPreference = "SilentlyContinue"

$App = "altimate"
$InstallDir = Join-Path $env:USERPROFILE ".altimate\bin"
$BinaryName = "$App.exe"
$InstalledBinary = Join-Path $InstallDir $BinaryName

# All user-facing errors go through Write-Err with a uniform "error: " prefix so
# logs are greppable; informational/secondary lines use the muted Write-Muted.
function Write-Muted($msg) { Write-Host $msg -ForegroundColor DarkGray }
function Write-Err($msg) { Write-Host "error: $msg" -ForegroundColor Red }

function Show-Usage {
  Write-Host @"
Altimate Code Installer (Windows)

Usage: irm https://www.altimate.sh/install.ps1 | iex
   or: install.ps1 [options]

Options:
    -Help                  Display this help message
    -Version <version>     Install a specific version (e.g. 1.0.180)
    -NoPathUpdate          Don't modify the user PATH
    -ForceBaseline         Install the non-AVX2 (baseline) build

Examples:
    powershell -c "irm https://www.altimate.sh/install.ps1 | iex"
    &([scriptblock]::Create((irm https://www.altimate.sh/install.ps1))) -Version 1.0.180
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

# A single P/Invoke type carries both native calls we need - the AVX2 CPU probe
# (kernel32) and the PATH-change broadcast (user32) - so we Add-Type once instead
# of compiling a throwaway type per call site.
function Initialize-Native {
  if (-not ("Win32.AltimateNative" -as [type])) {
    Add-Type -Namespace Win32 -Name AltimateNative -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
  }
}

# Verify a downloaded archive against the release's checksums.txt.
# Hard-fails (throws) on a real mismatch. Soft-skips when checksums.txt can't be
# fetched (older release, network blip) or has no entry for this file, so pinned
# installs of pre-checksums releases keep working.
function Test-Checksum {
  param([string]$Path, [string]$Name, [string]$ChecksumsUrl)

  $sums = $null
  try {
    $resp = Invoke-WebRequest -Uri $ChecksumsUrl -UseBasicParsing
    # On Windows PowerShell 5.1, .Content is a Byte[] (not a String) whenever the
    # response isn't a text-recognized content-type - and GitHub serves release
    # assets as application/octet-stream. A raw Byte[] coerces to a "49 50 51 ..."
    # decimal string when split, so verification would silently soft-skip on the
    # default Windows shell. Decode the bytes explicitly to recover real text.
    if ($resp.Content -is [byte[]]) {
      $sums = [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
      $sums = $resp.Content
    }
  } catch {
    Write-Muted "Skipping integrity check - checksums.txt not published for this release"
    return
  }

  # checksums.txt is sha256sum format: "<hash>  <filename>" (one entry per line).
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s\*?$([regex]::Escape($Name))\s*$" } | Select-Object -First 1
  if (-not $line) {
    Write-Muted "Skipping integrity check - no checksum entry for $Name"
    return
  }

  $expected = (($line -split '\s+')[0]).ToLower()
  $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    throw "Checksum mismatch for $Name (expected $expected, got $actual)"
  }
  Write-Muted "Verified $Name (sha256)"
}

# ---------------------------------------------------------------------------
# Architecture / baseline detection
# ---------------------------------------------------------------------------
# Only win32-x64 is built. @altimateai/altimate-core has no NAPI prebuild for
# win32-arm64, so ARM64 has no standalone archive (see packages/opencode/script/build.ts).
#
# Under WOW64 (a 32-bit PowerShell host on 64-bit Windows) PROCESSOR_ARCHITECTURE
# reports "x86"; the true machine arch lives in PROCESSOR_ARCHITEW6432. Prefer the
# latter so a real AMD64 box isn't misdetected as unsupported x86.
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($rawArch -ne "AMD64") {
  Write-Err "Unsupported OS/Arch: windows/$rawArch"
  Write-Muted "The standalone Windows build is x64 (AMD64) only. On Windows-on-ARM, use WSL or npm install -g altimate-code."
  exit 1
}
$arch = "x64"

# AVX2 detection via the same Win32 API the bash installer shells out to.
# IsProcessorFeaturePresent(40) == PF_AVX2_INSTRUCTIONS_AVAILABLE.
function Test-Avx2 {
  try {
    Initialize-Native
    return [bool][Win32.AltimateNative]::IsProcessorFeaturePresent(40)
  } catch {
    # If detection fails, assume no AVX2 and fall back to the baseline build -
    # the baseline binary runs everywhere, an AVX2 binary on a non-AVX2 CPU crashes.
    return $false
  }
}

# ---------------------------------------------------------------------------
# Resolve version (once) - latest tag or a pinned release
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Version)) {
  $useLatest = $true
  # The download below resolves "latest" server-side (releases/latest/download),
  # so this API call only feeds the version-string display and the
  # already-installed short-circuit. A transient api.github.com blip or the
  # unauthenticated rate limit (60/hr/IP) must NOT abort the install - retry a
  # few times, then proceed without the version string.
  $specificVersion = ""
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      # -TimeoutSec 10 bounds a stuck socket: Invoke-RestMethod defaults to 100s
      # on PS 5.1 and is effectively unbounded on PS 7+, so without it three
      # back-to-back retries on dead air could freeze for minutes.
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/AltimateAI/altimate-code/releases/latest" -Headers @{ "User-Agent" = "altimate-install" } -TimeoutSec 10
      $specificVersion = ($rel.tag_name -replace '^v', '')
      if (-not [string]::IsNullOrWhiteSpace($specificVersion)) { break }
    } catch {}
    if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
  }
  if ([string]::IsNullOrWhiteSpace($specificVersion)) {
    Write-Muted "Could not resolve the latest version from GitHub (API unavailable) - installing the latest release anyway."
    # Reset to $null (not ""): the already-installed short-circuit below compares
    # $installedVersion -eq $specificVersion. If the version probe of a missing or
    # corrupt binary also yields "", an "" -eq "" match would falsely report
    # "already installed" and skip the reinstall. $null -eq "" is $false, so the
    # comparison correctly falls through; the banner still shows "latest" because
    # if ($specificVersion) treats $null as falsy.
    $specificVersion = $null
  }
} else {
  $useLatest = $false
  # Strip a leading 'v' if present.
  $Version = $Version -replace '^v', ''
  $specificVersion = $Version

  # Verify the release exists before downloading (mirrors the bash 404 pre-check).
  try {
    Invoke-WebRequest -Uri "https://github.com/AltimateAI/altimate-code/releases/tag/v$Version" -Method Head -UseBasicParsing | Out-Null
  } catch {
    Write-Err "Release v$Version not found"
    Write-Muted "Available releases: https://github.com/AltimateAI/altimate-code/releases"
    exit 1
  }
}

# ---------------------------------------------------------------------------
# Skip if the requested version is already installed
# ---------------------------------------------------------------------------
# Probe both names: the standalone install ships `altimate`, but an npm install
# also exposes the `altimate-code` alias.
$probe = $null
foreach ($name in @("altimate", "altimate-code")) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { $probe = $cmd.Source; break }
}
if ($probe) {
  $installedVersion = ""
  try { $installedVersion = (& $probe --version 2>$null | Select-Object -First 1).ToString().Trim() } catch {}
  if ($installedVersion -eq $specificVersion) {
    Write-Muted "Version $specificVersion already installed"
    exit 0
  } elseif ($installedVersion) {
    Write-Muted "Installed version: $installedVersion."
  }
}

# ---------------------------------------------------------------------------
# Download + extract a single target archive into $InstallDir
# ---------------------------------------------------------------------------
function Install-Target {
  param([bool]$Baseline)

  $target = "windows-$arch"
  if ($Baseline) { $target = "$target-baseline" }
  $filename = "$App-$target.zip"

  # Pin BOTH the archive and checksums.txt to the same resolved release. The
  # mutable releases/latest/download URL would fetch the two assets in separate
  # requests, so a release published mid-install could hand back an archive from
  # one release and checksums from another -> a spurious hard-fail. We resolve
  # the concrete tag up front ($specificVersion), so pin to it. Only fall back
  # to the mutable latest/ URL when the version genuinely couldn't be resolved.
  if ($useLatest -and -not $specificVersion) {
    $base = "https://github.com/AltimateAI/altimate-code/releases/latest/download"
  } else {
    $base = "https://github.com/AltimateAI/altimate-code/releases/download/v$specificVersion"
  }
  $url = "$base/$filename"
  $checksumsUrl = "$base/checksums.txt"

  Write-Host ""
  Write-Host "Installing $App version: $(if ($specificVersion) { $specificVersion } else { 'latest' })"

  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "altimate_install_$PID"
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $zipPath = Join-Path $tmpDir $filename

  try {
    # Prefer curl.exe (ships with Windows 10 1803+) for a fast download with
    # --fail so HTTP errors don't write an error page to disk; fall back to
    # Invoke-WebRequest where curl.exe is unavailable.
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      & $curl.Source "-#SfLo" $zipPath $url
      if ($LASTEXITCODE -ne 0) { throw "curl.exe failed downloading $url (exit $LASTEXITCODE)" }
    } else {
      Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    }

    # Integrity check: hard-fail on mismatch; skip (with notice) when the release
    # predates checksums.txt or the fetch fails, so older pinned installs still work.
    Test-Checksum -Path $zipPath -Name $filename -ChecksumsUrl $checksumsUrl

    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
    $extracted = Join-Path $tmpDir $BinaryName
    if (-not (Test-Path $extracted)) {
      throw "Archive did not contain $BinaryName"
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Windows locks a running .exe, so `altimate upgrade` (which re-runs this
    # installer) can't overwrite the binary that is currently executing. Windows
    # *does* allow renaming a running exe - move the old one aside first, then
    # drop the new one in. Best-effort cleanup of the stale copy afterward.
    if (Test-Path $InstalledBinary) {
      $stale = "$InstalledBinary.old"
      Remove-Item -Force $stale -ErrorAction SilentlyContinue
      try { Move-Item -Force -Path $InstalledBinary -Destination $stale } catch {}
    }
    Move-Item -Force -Path $extracted -Destination $InstalledBinary
    Remove-Item -Force "$InstalledBinary.old" -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -Recurse -Force -Path $tmpDir -ErrorAction SilentlyContinue
  }
}

$needsBaseline = $ForceBaseline -or (-not (Test-Avx2))
Install-Target -Baseline:$needsBaseline

# ---------------------------------------------------------------------------
# Illegal-instruction retry (AVX2 misdetection rescue)
# ---------------------------------------------------------------------------
# If the freshly installed AVX2 binary won't run on this CPU it exits with
# STATUS_ILLEGAL_INSTRUCTION (0xC000001D == 3221225501, surfaced as 1073741795
# in some shells). Re-download the baseline build once.
if (-not $needsBaseline) {
  & $InstalledBinary --version *> $null
  $code = $LASTEXITCODE
  if ($code -eq 3221225501 -or $code -eq 1073741795 -or $code -eq -1073741795) {
    Write-Muted "CPU lacks AVX2 - reinstalling the baseline build"
    Install-Target -Baseline:$true
  }
}

# ---------------------------------------------------------------------------
# PATH (user scope, via registry + broadcast)
# ---------------------------------------------------------------------------
# Write the user PATH through the registry (not setx, which truncates at 1024
# chars) and broadcast WM_SETTINGCHANGE so already-open shells pick it up.
function Publish-EnvChange {
  Initialize-Native
  $HWND_BROADCAST = [IntPtr]0xffff
  $WM_SETTINGCHANGE = 0x1a
  $result = [UIntPtr]::Zero
  [Win32.AltimateNative]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
}

if (-not $NoPathUpdate) {
  # Read the raw (unexpanded) user PATH from the registry so we don't clobber
  # %VAR%-style entries on write.
  $regKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  if (-not $regKey) {
    $regKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  }
  $userPath = $regKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($userPath -split ';' | Where-Object { $_ -ne "" })
  if ($entries -notcontains $InstallDir) {
    $newPath = (@($InstallDir) + $entries) -join ';'
    $regKey.SetValue("Path", $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Publish-EnvChange
    # Update the current session too so the post-install hints work immediately.
    $env:Path = "$InstallDir;$env:Path"
    Write-Muted "Successfully added $App to PATH in the user environment ($InstallDir)"
  }
  $regKey.Close()
} else {
  Write-Muted "Skipped PATH modification (--no-modify-path). Add manually: $InstallDir"
}

# GitHub Actions: expose the install dir to subsequent steps (mirrors install:504).
if ($env:GITHUB_ACTIONS -eq "true" -and $env:GITHUB_PATH) {
  Add-Content -Path $env:GITHUB_PATH -Value $InstallDir
  Write-Muted "Added $InstallDir to `$GITHUB_PATH"
}

Write-Host ""
Write-Host ""
Write-Muted "Get started:"
Write-Host ""
Write-Host "altimate                 # Open the TUI"
Write-Host "altimate run `"hello`"     # Run a quick task"
Write-Host "altimate --help          # See all commands"
Write-Host ""
Write-Muted "Docs: https://altimate-code.dev"
Write-Host ""
