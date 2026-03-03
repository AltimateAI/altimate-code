# Windows / WSL

altimate-code is supported on Windows through WSL (Windows Subsystem for Linux).

## WSL Setup

1. Install WSL:
   ```powershell
   wsl --install
   ```

2. Install Node.js in WSL:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. Install altimate-code:
   ```bash
   npm install -g @altimateai/altimate-code
   ```

4. Launch:
   ```bash
   altimate-code
   ```

## Git Bash Path

If you need to use Git Bash instead of WSL:

```bash
export ALTIMATE_CLI_GIT_BASH_PATH="C:\\Program Files\\Git\\bin\\bash.exe"
```

## Known Limitations

- The TUI works best in Windows Terminal or a modern terminal emulator
- Some terminal features may not work in older cmd.exe or PowerShell windows
- File watching may have delays due to WSL filesystem bridging

## Tips

- Use WSL 2 for better performance
- Store your projects in the WSL filesystem (`~/projects/`) rather than `/mnt/c/` for faster file operations
- Set up your warehouse connections in the WSL environment
