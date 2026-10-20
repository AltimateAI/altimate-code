# Pester behavioral tests for install.ps1 (the Windows standalone installer).
#
# Two layers, because no single one reaches everything:
#
# 1. SUBPROCESS tests run the real script and exercise actual behavior - not just
#    substring matching. They deliberately stop it early (via -Help or an unknown
#    -Version) so no 268 MB binary is ever downloaded, covering argument parsing,
#    the WOW64 architecture fix, and unknown-version rejection. Because they stop
#    early they never reach anything past version resolution.
#
# 2. AST-EXTRACTED tests parse install.ps1, pull a single function out of the tree
#    and dot-source it, so code the subprocess tests can never reach is still
#    executed. Used for Test-Checksum and Write-InstallMarker. These must set
#    $ErrorActionPreference = "Stop" themselves to match the installer's own
#    semantics - see the note in the Write-InstallMarker BeforeAll.
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

# ---------------------------------------------------------------------------
# Write-InstallMarker (install telemetry — #1096)
# ---------------------------------------------------------------------------
# The subprocess tests above stop the installer via -Help / unknown -Version, so
# they never reach the marker block. It is AST-extracted and executed here instead,
# the same way Test-Checksum is, against a temp profile. This is the only runtime
# coverage the PowerShell writer has.
Describe "install.ps1 Write-InstallMarker" {
  BeforeAll {
    $src = Get-Content -Raw $script:InstallScript
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
    $def = $ast.Find({
      param($n)
      $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Write-InstallMarker"
    }, $true)
    if (-not $def) { throw "Write-InstallMarker not found in install.ps1" }
    . ([ScriptBlock]::Create($def.Extent.Text))

    # MUST match the installer's own error semantics. install.ps1:28 sets
    # $ErrorActionPreference = "Stop" at script scope, and that is the entire reason
    # Write-InstallMarker needs its try/catch: under "Stop" a failing cmdlet is
    # TERMINATING. Dot-sourcing the function out of the AST lands it in a session
    # where pwsh's default "Continue" applies, under which a New-Item failure merely
    # writes to the error stream — so "Should -Not -Throw" would pass with the
    # try/catch deleted, and the test could not fail.
    $ErrorActionPreference = "Stop"
    $script:ErrorActionPreference = "Stop"

    # Mirrors welcome.ts::getDataDir(): $XDG_DATA_HOME, else <home>/.local/share.
    function Get-MarkerDir {
      param([string]$Root)
      [IO.Path]::Combine($Root, "altimate-code")
    }
  }

  BeforeEach {
    $script:Sandbox = Join-Path ([IO.Path]::GetTempPath()) ("marker-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $script:Sandbox | Out-Null
    $script:OldXdg = $env:XDG_DATA_HOME
    $script:OldProfile = $env:USERPROFILE
  }

  AfterEach {
    $env:XDG_DATA_HOME = $script:OldXdg
    $env:USERPROFILE = $script:OldProfile
    Remove-Item -Recurse -Force $script:Sandbox -ErrorAction SilentlyContinue
  }

  It "writes both marker files with byte-exact content and no BOM" {
    $env:XDG_DATA_HOME = $script:Sandbox
    Write-InstallMarker -Version "1.2.3"

    $dir = Get-MarkerDir $script:Sandbox
    # Byte-level: a BOM would make install_method fail the CLI's allowlist match.
    $verBytes = [IO.File]::ReadAllBytes([IO.Path]::Combine($dir, ".installed-version"))
    $srcBytes = [IO.File]::ReadAllBytes([IO.Path]::Combine($dir, ".install-source"))
    [System.Text.Encoding]::ASCII.GetString($verBytes) | Should -BeExactly "1.2.3"
    [System.Text.Encoding]::ASCII.GetString($srcBytes) | Should -BeExactly "powershell"
    $verBytes[0] | Should -Not -Be 0xEF
    $srcBytes[0] | Should -Not -Be 0xEF
  }

  It "strips a leading v and falls back to 'unknown' for an unresolved version" {
    $env:XDG_DATA_HOME = $script:Sandbox
    Write-InstallMarker -Version "v9.9.9"
    $dir = Get-MarkerDir $script:Sandbox
    Get-Content -Raw ([IO.Path]::Combine($dir, ".installed-version")) | Should -BeExactly "9.9.9"

    # Empty version must NOT produce an empty marker — the CLI deletes those unread.
    Write-InstallMarker -Version ""
    Get-Content -Raw ([IO.Path]::Combine($dir, ".installed-version")) | Should -BeExactly "unknown"
  }

  It "falls back to <USERPROFILE>/.local/share when XDG_DATA_HOME is unset" {
    $env:XDG_DATA_HOME = ""
    $env:USERPROFILE = $script:Sandbox
    Write-InstallMarker -Version "1.0.0"
    $dir = [IO.Path]::Combine($script:Sandbox, ".local", "share", "altimate-code")
    Test-Path ([IO.Path]::Combine($dir, ".installed-version")) | Should -BeTrue
  }

  It "does not throw when USERPROFILE is empty and XDG_DATA_HOME is unset" {
    # The regression guard for path computation inside the try. With
    # $ErrorActionPreference = "Stop", computing this outside the try raised a
    # terminating error that aborted the installer AFTER the binary was placed but
    # BEFORE the PATH write - leaving an installed binary that is not on PATH.
    #
    # Runs inside the sandbox via Push-Location. [IO.Path]::Combine("", ".local",
    # "share") does NOT throw - it returns the RELATIVE path ".local\share" - so the
    # marker is created under the current working directory. Without Push-Location
    # that is the git checkout root, and every CI run would litter it.
    $env:XDG_DATA_HOME = ""
    $env:USERPROFILE = ""
    Push-Location $script:Sandbox
    try {
      { Write-InstallMarker -Version "1.0.0" } | Should -Not -Throw
      # Documents where an empty profile actually lands: relative to cwd, not $HOME.
      Test-Path ([IO.Path]::Combine(".local", "share", "altimate-code", ".installed-version")) |
        Should -BeTrue
    } finally {
      Pop-Location
    }
  }

  It "does not throw when the data dir cannot be created, and writes no marker" {
    # Runs under $ErrorActionPreference = "Stop" (set in BeforeAll), so New-Item's
    # failure here is terminating and the try/catch is what makes this pass. Deleting
    # the try/catch must fail this case — that is what makes it a real guard.
    $blocker = Join-Path $script:Sandbox "blocker"
    Set-Content -Path $blocker -Value "x" -NoNewline
    $env:XDG_DATA_HOME = [IO.Path]::Combine($blocker, "nested")

    { Write-InstallMarker -Version "1.0.0" } | Should -Not -Throw

    # Proves the fixture actually hit the intended failure path rather than quietly
    # succeeding somewhere else: no marker may exist under the blocked root.
    Test-Path ([IO.Path]::Combine($blocker, "nested", "altimate-code", ".installed-version")) |
      Should -BeFalse
  }

  It "runs under the installer's Stop semantics" {
    # Guards the BeforeAll above: if this drifts back to "Continue", the two
    # "does not throw" cases silently stop being able to fail.
    $ErrorActionPreference | Should -Be "Stop"
  }
}

Describe "install.ps1 Install-Alias" {
  BeforeAll {
    $src = Get-Content -Raw $script:InstallScript
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
    $def = $ast.Find({
      param($n)
      $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Install-Alias"
    }, $true)
    if (-not $def) { throw "Install-Alias not found in install.ps1" }
    . ([ScriptBlock]::Create($def.Extent.Text))
    function Write-Muted($msg) { }

    # Same reason as Write-InstallMarker: the installer runs under "Stop".
    $ErrorActionPreference = "Stop"
    $script:ErrorActionPreference = "Stop"
  }

  BeforeEach {
    $script:Sandbox = Join-Path ([IO.Path]::GetTempPath()) ("alias-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $script:Sandbox | Out-Null
  }

  AfterEach {
    Remove-Item -Recurse -Force $script:Sandbox -ErrorAction SilentlyContinue
  }

  It "writes an altimate-code.cmd shim that forwards to altimate.exe" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Install-Alias -Dir $script:Sandbox

    $shim = [IO.File]::ReadAllText([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd"))
    $shim | Should -Be "@echo off`r`n`"%~dp0altimate.exe`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  }

  It "writes an extensionless shim for Git Bash that forwards to altimate.exe only there" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Install-Alias -Dir $script:Sandbox

    $shim = [IO.File]::ReadAllText([IO.Path]::Combine($script:Sandbox, "altimate-code"))
    $expected = ((@(
          '#!/bin/sh'
          'case "$(uname -s)" in'
          '  MINGW*|MSYS*|CYGWIN*) exec "$(dirname "$0")/altimate.exe" "$@" ;;'
          'esac'
          'echo "altimate-code: this is the Windows build; it runs only from Git Bash, MSYS or Cygwin" >&2'
          'exit 127'
        ) -join "`n") + "`n")
    $shim | Should -Be $expected
  }

  # Needs cmd.exe; skipped when the suite runs under pwsh on macOS or Linux.
  It "runs altimate.exe through the .cmd shim with its arguments and exit code" -Skip:($env:OS -ne "Windows_NT") {
    # cmd.exe stands in for altimate.exe: a real executable whose output and exit
    # code are driven entirely by the forwarded arguments.
    Copy-Item -LiteralPath $env:ComSpec -Destination ([IO.Path]::Combine($script:Sandbox, "altimate.exe"))
    Install-Alias -Dir $script:Sandbox
    $shim = [IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")

    (& $shim /c echo forwarded) | Should -Be "forwarded"
    & $shim /c exit 7
    $LASTEXITCODE | Should -Be 7
  }

  It "replaces a hard link at the shim path without writing through it" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    $outside = [IO.Path]::Combine($script:Sandbox, "outside.txt")
    Set-Content -Path $outside -Value "untouched" -NoNewline
    New-Item -ItemType HardLink -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) -Target $outside | Out-Null
    Install-Alias -Dir $script:Sandbox

    [IO.File]::ReadAllText($outside) | Should -Be "untouched"
    [IO.File]::ReadAllText([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Should -Match "altimate.exe"
  }

  It "replaces a junction or directory link at the shim path without touching its target" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    $outsideDir = [IO.Path]::Combine($script:Sandbox, "outside")
    New-Item -ItemType Directory -Path $outsideDir | Out-Null
    Set-Content -Path ([IO.Path]::Combine($outsideDir, "keep.txt")) -Value "untouched" -NoNewline
    # pwsh off Windows silently creates no junction; a directory symlink is the same case there.
    $linkType = if ($env:OS -eq "Windows_NT") { "Junction" } else { "SymbolicLink" }
    $link = [IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")
    New-Item -ItemType $linkType -Path $link -Target $outsideDir | Out-Null
    (Get-Item -LiteralPath $link -Force).LinkType | Should -Be $linkType
    Install-Alias -Dir $script:Sandbox

    [IO.File]::ReadAllText([IO.Path]::Combine($outsideDir, "keep.txt")) | Should -Be "untouched"
    Test-Path -LiteralPath ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) -PathType Leaf | Should -BeTrue
  }

  It "cleans up an altimate-code.exe.old left by an earlier run" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe.old")) -Value "old" -NoNewline
    Install-Alias -Dir $script:Sandbox

    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe.old")) | Should -BeFalse
  }

  It "removes a stale altimate-code.exe that would shadow the shim" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) -Value "stale" -NoNewline
    Install-Alias -Dir $script:Sandbox

    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) | Should -BeFalse
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Should -BeTrue
  }

  It "creates nothing when altimate.exe is not installed" {
    Install-Alias -Dir $script:Sandbox
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Should -BeFalse
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code")) | Should -BeFalse
  }

  It "keeps an existing altimate-code.exe when the shim cannot be written" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) -Value "old" -NoNewline
    New-Item -ItemType Directory -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Out-Null

    { Install-Alias -Dir $script:Sandbox } | Should -Not -Throw
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) | Should -BeTrue
  }

  It "keeps the Git Bash shim when the .cmd shim cannot be written" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code")) -Value "previous" -NoNewline
    New-Item -ItemType Directory -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Out-Null

    { Install-Alias -Dir $script:Sandbox } | Should -Not -Throw
    [IO.File]::ReadAllText([IO.Path]::Combine($script:Sandbox, "altimate-code")) | Should -Be "previous"
  }

  It "removes a shadowing altimate-code.exe once the .cmd exists, even if the Git Bash shim fails" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) -Value "stale" -NoNewline
    New-Item -ItemType Directory -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code")) | Out-Null

    { Install-Alias -Dir $script:Sandbox } | Should -Not -Throw
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) -PathType Leaf | Should -BeTrue
    Test-Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.exe")) | Should -BeFalse
  }

  # Needs symlink privilege, which Windows CI runners have; off Windows the test above covers it.
  It "replaces a Windows directory symlink at the shim path without touching its target" -Skip:($env:OS -ne "Windows_NT") {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    $outsideDir = [IO.Path]::Combine($script:Sandbox, "outside")
    New-Item -ItemType Directory -Path $outsideDir | Out-Null
    Set-Content -Path ([IO.Path]::Combine($outsideDir, "keep.txt")) -Value "untouched" -NoNewline
    $link = [IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")
    New-Item -ItemType SymbolicLink -Path $link -Target $outsideDir | Out-Null
    Install-Alias -Dir $script:Sandbox

    [IO.File]::ReadAllText([IO.Path]::Combine($outsideDir, "keep.txt")) | Should -Be "untouched"
    Test-Path -LiteralPath $link -PathType Leaf | Should -BeTrue
  }

  It "does not throw when the shim cannot be written" {
    Set-Content -Path ([IO.Path]::Combine($script:Sandbox, "altimate.exe")) -Value "x" -NoNewline
    New-Item -ItemType Directory -Path ([IO.Path]::Combine($script:Sandbox, "altimate-code.cmd")) | Out-Null

    { Install-Alias -Dir $script:Sandbox } | Should -Not -Throw
  }
}

Describe "install.ps1 Test-PathInDir" {
  BeforeAll {
    $src = Get-Content -Raw $script:InstallScript
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
    $def = $ast.Find({
      param($n)
      $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Test-PathInDir"
    }, $true)
    if (-not $def) { throw "Test-PathInDir not found in install.ps1" }
    . ([ScriptBlock]::Create($def.Extent.Text))
    $script:Dir = [IO.Path]::Combine([IO.Path]::GetTempPath(), "altimate-home", ".altimate", "bin")
  }

  It "matches a file directly in the directory" {
    Test-PathInDir -Path ([IO.Path]::Combine($script:Dir, "altimate.exe")) -Dir $script:Dir | Should -BeTrue
  }

  It "ignores a trailing separator on the directory" {
    Test-PathInDir -Path ([IO.Path]::Combine($script:Dir, "altimate.exe")) -Dir ($script:Dir + [IO.Path]::DirectorySeparatorChar) | Should -BeTrue
  }

  It "ignores case" {
    Test-PathInDir -Path ([IO.Path]::Combine($script:Dir.ToUpperInvariant(), "altimate.exe")) -Dir $script:Dir | Should -BeTrue
  }

  It "resolves . and .. segments" {
    $spelled = [IO.Path]::Combine($script:Dir, "..", "bin", ".", "altimate.exe")
    Test-PathInDir -Path $spelled -Dir $script:Dir | Should -BeTrue
  }

  It "does not match another directory" {
    $other = [IO.Path]::Combine([IO.Path]::GetTempPath(), "npm", "altimate.exe")
    Test-PathInDir -Path $other -Dir $script:Dir | Should -BeFalse
  }

  It "does not match a subdirectory" {
    Test-PathInDir -Path ([IO.Path]::Combine($script:Dir, "nested", "altimate.exe")) -Dir $script:Dir | Should -BeFalse
  }
}
