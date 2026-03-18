# Windows / WSL

altimate runs on Windows both natively (via Node.js on Windows) and through WSL (Windows Subsystem for Linux). WSL 2 is recommended for the best experience, but it is not required.

## Windows Native Install

You can install and run altimate directly in PowerShell or Command Prompt without WSL:

```powershell
# PowerShell or CMD — install globally
npm install -g @altimateai/altimate-code

# Launch
altimate
```

This works with Node.js 18+ installed natively on Windows. All core features work in native mode, including warehouse connections, agent modes, and the TUI.

## WSL Setup (Recommended)

For the best experience — especially with file watching, shell tools, and dbt — we recommend WSL 2:

1. Install WSL:
   ```powershell
   wsl --install
   ```

2. Install Node.js in WSL:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. Install altimate:
   ```bash
   npm install -g altimate-code
   ```

4. Launch:
   ```bash
   altimate
   ```

## Windows Terminal

For the best TUI experience on Windows, use [Windows Terminal](https://aka.ms/terminal) with a Nerd Font installed. Windows Terminal supports true color, Unicode, and the full range of TUI features that altimate uses.

To install a Nerd Font:

1. Download a Nerd Font from [nerdfonts.com](https://www.nerdfonts.com/font-downloads) (e.g., "FiraCode Nerd Font")
2. Install the font on your system
3. In Windows Terminal, go to **Settings > Profiles > Defaults > Appearance** and set the font face to the installed Nerd Font

> **Note:** The default `cmd.exe` and older PowerShell windows have limited Unicode support, which may cause rendering issues with altimate's TUI elements.

## Git Bash Path

If you need to use Git Bash instead of WSL:

```bash
export ALTIMATE_CLI_GIT_BASH_PATH="C:\\Program Files\\Git\\bin\\bash.exe"
```

## Known Limitations

- The TUI works best in Windows Terminal or a modern terminal emulator
- Some terminal features may not work in older cmd.exe or PowerShell windows
- File watching may have delays due to WSL filesystem bridging

## Troubleshooting

### Path separator issues

Windows uses backslashes (`\`) in file paths, but altimate config files should always use **forward slashes** (`/`), even on Windows. This applies to all paths in `altimate-code.json`:

```json
{
  "warehouses": {
    "local-duckdb": {
      "type": "duckdb",
      "database": "C:/Users/analyst/projects/dev.duckdb"
    }
  }
}
```

**Wrong** (will cause errors):

```json
{
  "database": "C:\\Users\\analyst\\projects\\dev.duckdb"
}
```

**Right:**

```json
{
  "database": "C:/Users/analyst/projects/dev.duckdb"
}
```

This also applies to paths like `private_key_path`, `service_account`, and any plugin paths specified in the config.

### Node.js not found after install

If you installed Node.js but `npm` or `node` is not recognized:

- Restart your terminal after installing Node.js
- Ensure the Node.js installation directory is in your system `PATH`
- In WSL, make sure you installed Node.js inside WSL, not on the Windows side

## Tips

- Use WSL 2 for better performance
- Store your projects in the WSL filesystem (`~/projects/`) rather than `/mnt/c/` for faster file operations
- Set up your warehouse connections in the WSL environment
- If using both WSL and native Windows, keep separate config files — the WSL and Windows file systems have different path conventions
