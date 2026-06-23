# Pester behavioral tests for install.ps1 (the Windows standalone installer).
#
# These run the real script as a subprocess on Windows PowerShell so they
# exercise actual behavior - not just substring matching. They deliberately
# stop the script early (via -Help or an unknown -Version) so no 268 MB binary
# is ever downloaded, while still covering the risky branches: argument
# parsing, the WOW64 architecture fix, and unknown-version rejection.
#
# Run locally on Windows:  Invoke-Pester ./test/windows/install.Tests.ps1
# CI runs this on windows-latest (see .github/workflows/ci.yml).

BeforeAll {
  $script:InstallScript = Join-Path $PSScriptRoot "..\..\install.ps1"

  # Invoke install.ps1 in a child pwsh with a controlled environment and return
  # @{ Code = <exit code>; Output = <combined stdout+stderr> }. PROCESSOR_* env
  # vars are passed per-call so we can simulate WOW64 / ARM64 hosts.
  #
  # The requested env vars are applied INSIDE the child session (via a -Command
  # preamble), not by mutating this host's Process-scope environment and relying
  # on inheritance. PROCESSOR_ARCHITECTURE is a loader-managed variable: the
  # windows-latest runner re-initializes it for a spawned process, so a
  # Process-scope override here does not reliably reach `pwsh -File` (the child
  # saw it blank). Setting it in the child's own session, after the loader has
  # run, is deterministic. An empty value removes the var so detection of a
  # "missing" PROCESSOR_ARCHITEW6432 falls through correctly.
  function Invoke-Installer {
    param(
      [string[]]$ScriptArgs = @(),
      [hashtable]$Env = @{}
    )
    # Single-quote PowerShell literals by doubling embedded single quotes.
    $sq = "'"; $escSq = "''"
    $preamble = ""
    foreach ($k in $Env.Keys) {
      $v = $Env[$k]
      if ([string]::IsNullOrEmpty($v)) {
        $preamble += "Remove-Item -Path Env:$k -ErrorAction SilentlyContinue; "
      } else {
        $vEsc = $v.Replace($sq, $escSq)
        $preamble += "`$env:$k = '$vEsc'; "
      }
    }
    # Pass the script args as bareword command-line tokens (e.g. `-Version
    # 0.0.0-nonexistent`) so parameter NAMES bind as names - matching the
    # original `pwsh -File <script> @ScriptArgs` semantics. Quoting them as
    # literals (or array-splatting) binds positionally instead, so $Version
    # would receive the literal string "-Version". The harness only ever passes
    # shell-safe tokens (-Help, -Version, version strings; no spaces/quotes).
    $argTokens = $ScriptArgs -join " "
    $scriptEsc = $script:InstallScript.Replace($sq, $escSq)
    $command = "$preamble & '$scriptEsc' $argTokens"
    $output = & pwsh -NoProfile -Command $command 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $output }
  }
}

Describe "install.ps1 syntax" {
  It "parses without errors" {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script:InstallScript, [ref]$tokens, [ref]$errors) | Out-Null
    $errors | Should -BeNullOrEmpty
  }
}

Describe "install.ps1 -Help" {
  It "prints usage and exits 0 without installing" {
    $r = Invoke-Installer -ScriptArgs @("-Help")
    $r.Code | Should -Be 0
    $r.Output | Should -Match "-NoPathUpdate"
    $r.Output | Should -Match "-ForceBaseline"
    $r.Output | Should -Match "-Version"
  }
}

Describe "install.ps1 architecture detection" {
  It "detects AMD64 under WOW64 (32-bit PowerShell on 64-bit Windows)" {
    # PROCESSOR_ARCHITECTURE=x86 but PROCESSOR_ARCHITEW6432=AMD64 -> real 64-bit box.
    # Using an unknown version makes the script stop at the release 404 check,
    # which it can only reach if the WOW64 arch check let it past.
    $r = Invoke-Installer -ScriptArgs @("-Version", "0.0.0-nonexistent") -Env @{
      PROCESSOR_ARCHITECTURE  = "x86"
      PROCESSOR_ARCHITEW6432  = "AMD64"
    }
    $r.Output | Should -Not -Match "Unsupported OS/Arch"
    $r.Output | Should -Match "not found"
  }

  It "rejects genuine 32-bit x86 (no ARCHITEW6432)" {
    $r = Invoke-Installer -ScriptArgs @("-Version", "0.0.0-nonexistent") -Env @{
      PROCESSOR_ARCHITECTURE  = "x86"
      PROCESSOR_ARCHITEW6432  = ""
    }
    $r.Code | Should -Be 1
    $r.Output | Should -Match "Unsupported OS/Arch: windows/x86"
  }

  It "rejects ARM64" {
    $r = Invoke-Installer -ScriptArgs @("-Version", "0.0.0-nonexistent") -Env @{
      PROCESSOR_ARCHITECTURE  = "ARM64"
      PROCESSOR_ARCHITEW6432  = ""
    }
    $r.Code | Should -Be 1
    $r.Output | Should -Match "Unsupported OS/Arch: windows/ARM64"
  }
}

Describe "install.ps1 version handling" {
  It "rejects an unknown pinned version with a friendly error" {
    $r = Invoke-Installer -ScriptArgs @("-Version", "0.0.0-nonexistent") -Env @{
      PROCESSOR_ARCHITECTURE = "AMD64"
    }
    $r.Code | Should -Be 1
    $r.Output | Should -Match "Release v0.0.0-nonexistent not found"
    $r.Output | Should -Match "Available releases"
  }
}

Describe "install.ps1 Test-Checksum" {
  # Exercise the real Test-Checksum function in isolation. install.ps1 runs
  # top-to-bottom (arch detection, version resolution, exit) so it can't just be
  # dot-sourced; instead extract the function via the AST and define it here,
  # alongside a recording Write-Muted stub and a fake Invoke-WebRequest that
  # returns canned content.
  BeforeAll {
    $src = Get-Content -Raw $script:InstallScript
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
    $def = $ast.Find({
      param($n)
      $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Test-Checksum"
    }, $true)
    if (-not $def) { throw "Test-Checksum not found in install.ps1" }
    . ([ScriptBlock]::Create($def.Extent.Text))

    # Records what Test-Checksum reports, so we can tell a real "Verified" from a
    # silent "Skipping integrity check" soft-skip.
    $script:Muted = [System.Collections.Generic.List[string]]::new()
    function Write-Muted { param([string]$Message) $script:Muted.Add($Message) }

    # Fake Invoke-WebRequest: a function shadows the cmdlet, returning whatever
    # $script:FakeContent is set to (string or Byte[]) as .Content.
    function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing) [pscustomobject]@{ Content = $script:FakeContent } }

    function New-FixtureArchive {
      $tmp = New-TemporaryFile
      "altimate-archive-fixture" | Set-Content -NoNewline -Path $tmp
      return $tmp
    }
  }

  BeforeEach { $script:Muted.Clear() }

  It "verifies a matching archive when checksums.txt is served as a String (PS 7)" {
    $tmp = New-FixtureArchive
    $name = Split-Path $tmp -Leaf
    $hash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    $script:FakeContent = "$hash  $name`n"
    { Test-Checksum -Path $tmp -Name $name -ChecksumsUrl "https://x/checksums.txt" } | Should -Not -Throw
    ($script:Muted -join "`n") | Should -Match "Verified"
    ($script:Muted -join "`n") | Should -Not -Match "Skipping"
    Remove-Item $tmp -Force
  }

  It "verifies a matching archive when checksums.txt is served as Byte[] (Windows PowerShell 5.1)" {
    # The regression guard: GitHub serves release assets as octet-stream, so on
    # PS 5.1 .Content is a Byte[]. Without the explicit UTF8 decode it coerces to
    # a "49 50 51 ..." decimal string, no entry matches, and the check soft-skips.
    $tmp = New-FixtureArchive
    $name = Split-Path $tmp -Leaf
    $hash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    $script:FakeContent = [System.Text.Encoding]::UTF8.GetBytes("$hash  $name`n")
    { Test-Checksum -Path $tmp -Name $name -ChecksumsUrl "https://x/checksums.txt" } | Should -Not -Throw
    ($script:Muted -join "`n") | Should -Match "Verified"
    ($script:Muted -join "`n") | Should -Not -Match "Skipping"
    Remove-Item $tmp -Force
  }

  It "hard-fails on a real checksum mismatch (Byte[] content)" {
    $tmp = New-FixtureArchive
    $name = Split-Path $tmp -Leaf
    $script:FakeContent = [System.Text.Encoding]::UTF8.GetBytes((("0" * 64) + "  $name`n"))
    { Test-Checksum -Path $tmp -Name $name -ChecksumsUrl "https://x/checksums.txt" } | Should -Throw
    Remove-Item $tmp -Force
  }
}
