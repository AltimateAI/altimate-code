# Databricks CLI Installation

Install or update the Databricks CLI on macOS, Windows, or Linux using doc-validated methods (Homebrew, WinGet, curl install script, manual download, or user directory install for non-sudo environments). Includes verification and common failure recovery.

## Sandboxed / IDE environments (Cursor, containers)

CLI install commands often write to system directories outside the workspace (e.g. `/opt/homebrew/`, `/usr/local/bin/`) which are blocked in sandboxed environments.

**Agent behavior**: Do not attempt to run install commands directly. Present the appropriate command to the user and ask them to run it in their own terminal. After they confirm, verify with `databricks -v`.

For Linux/macOS containers or Cursor: prefer the **Linux manual install to user directory** method (`~/.local/bin`) — it requires no sudo and no writes outside the workspace.

## Preconditions (always do first)
1. Determine OS and shell:
   - macOS/Linux: bash/zsh
   - Windows: Command Prompt / PowerShell; optionally WSL for Linux shell
2. Detect whether `databricks` is already installed:
   - Run: `databricks -v` (or `databricks version`)
   - If already installed with a recent version, installation is already OK.
3. Avoid the legacy Python package `databricks-cli` (PyPI). This skill installs the modern Databricks CLI binary.

## Preferred installation paths (by OS)

### macOS (preferred: Homebrew)
Run:
- `brew tap databricks/tap`
- `brew install databricks`

Verify:
- `databricks -v` (or `databricks version`)

If macOS blocks the binary (Gatekeeper), follow Apple’s “open app from unidentified developer” flow.

#### macOS fallback: curl installer
Run:
- `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`

Notes:
- If `/usr/local/bin` is not writable, re-run with `sudo`.
- Installs to `/usr/local/bin/databricks`.

Verify:
- `databricks -v`

### Linux (preferred: Homebrew if available)
Run:
- `brew tap databricks/tap`
- `brew install databricks`

Verify:
- `databricks -v`

#### Linux fallback: curl installer
Run:
- `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`

Notes:
- If `/usr/local/bin` is not writable, re-run with `sudo`.
- Installs to `/usr/local/bin/databricks`.

Verify:
- `databricks -v`

#### Linux alternative: Manual install to user directory (when sudo unavailable)
Use this when sudo is not available or requires interactive password entry.

Steps:
1. Detect architecture:
   - `uname -m` (e.g., `x86_64`, `aarch64`)
2. Get the latest download URL using GitHub API:
   ```bash
   curl -s https://api.github.com/repos/databricks/cli/releases/latest | grep "browser_download_url.*linux.*$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')" | head -1 | cut -d '"' -f 4
   ```
3. Download and install to `~/.local/bin`:
   ```bash
   mkdir -p ~/.local/bin
   cd ~/.local/bin
   curl -L "<download-url>" -o databricks.tar.gz
   tar -xzf databricks.tar.gz
   rm databricks.tar.gz
   chmod +x databricks
   ```
4. Add to PATH (add to `~/.bashrc` or `~/.zshrc` for persistence):
   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```
5. Verify:
   - `databricks -v`

Notes:
- The download files are `.tar.gz` archives (not `.zip`) with naming pattern: `databricks_cli_<version>_linux_<arch>.tar.gz`
- Common architectures: `amd64` (x86_64), `arm64` (aarch64)
- This method works in containerized environments and sandboxed IDEs (e.g. Cursor) without sudo access

### Windows (preferred: WinGet)
Run in Command Prompt (then restart the terminal session):
- `winget search databricks`
- `winget install Databricks.DatabricksCLI`

Verify:
- `databricks -v`

#### Windows alternative: Chocolatey (Experimental)
Run:
- `choco install databricks-cli`

Verify:
- `databricks -v`

#### Windows fallback: curl installer (recommended via WSL)
Databricks recommends WSL for the curl-based install path.
Requirements:
- WSL available
- `unzip` installed in the environment where you run the installer

Run (in WSL bash):
- `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`

Verify (in same environment):
- `databricks -v`

If you must run curl install outside WSL, run as Administrator.
Installs to `C:\Windows\databricks.exe`.

## Manual install (all OSes): download from GitHub releases
Use this when package managers or curl install are not possible.

Steps:
1. Get the latest release download URL:
   - Visit https://github.com/databricks/cli/releases/latest
   - OR use GitHub API: `curl -s https://api.github.com/repos/databricks/cli/releases/latest | grep browser_download_url`
2. Download the appropriate file for your OS and architecture:
   - Linux: `databricks_cli_<version>_linux_<arch>.tar.gz` (use tar -xzf)
   - macOS: `databricks_cli_<version>_darwin_<arch>.zip` (use unzip)
   - Windows: `databricks_cli_<version>_windows_<arch>.zip` (use native extraction)
   - Common architectures: `amd64` (x86_64), `arm64` (aarch64/Apple Silicon)
3. Extract the archive.
4. Ensure the extracted `databricks` executable is on PATH, or run it from its folder.
5. Verify with `databricks -v`.

## Update / repair procedures

### Homebrew update (macOS/Linux)
- `brew upgrade databricks`
- `databricks -v`

### WinGet update (Windows)
- `winget upgrade Databricks.DatabricksCLI`
- `databricks -v`

### curl update (all OSes)
1. Delete existing binary:
   - macOS/Linux: `/usr/local/bin/databricks`
   - Windows: `C:\Windows\databricks.exe`
2. Re-run:
   - `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`
3. Verify:
   - `databricks -v`

## Common failures & fixes (agent playbook)
- `Target path <path> already exists`:
  - Delete the existing binary at the install target, then rerun.
- Permission error writing `/usr/local/bin`:
  - Re-run curl installer with `sudo` (macOS/Linux).
  - If sudo requires interactive password, use manual install to `~/.local/bin` instead.
- `sudo: a terminal is required to read the password`:
  - Cannot use sudo in non-interactive environments (containers, CI/CD).
  - Use manual install to `~/.local/bin` method instead (see "Linux alternative" section).
- Windows PATH not updated after WinGet:
  - Restart Command Prompt/PowerShell.
- Multiple `databricks` binaries on PATH:
  - Use `which databricks` (macOS/Linux/WSL) or `where databricks` (Windows) and remove the wrong one.
- Wrong file type (trying to unzip a tar.gz):
  - Linux releases are `.tar.gz` files, use `tar -xzf` not `unzip`.
  - macOS and Windows releases are `.zip` files, use appropriate extraction tool.
- `databricks: command not found` after installation to `~/.local/bin`:
  - Add to PATH: `export PATH="$HOME/.local/bin:$PATH"`
  - For persistence, add the export command to `~/.bashrc` or `~/.zshrc`.
