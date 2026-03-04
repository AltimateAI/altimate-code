# Troubleshooting

## Log Files

Logs are stored at:

```
~/.local/share/altimate-code/log/
```

Enable verbose logging:

```bash
altimate --print-logs --log-level DEBUG
```

## Common Issues

### Provider Connection Failed

**Symptoms:** "Failed to connect to provider" or timeout errors.

**Solutions:**

1. Verify your API key is set:
   ```bash
   echo $ANTHROPIC_API_KEY
   ```
2. Check network connectivity to the provider
3. If behind a proxy, set `HTTPS_PROXY` (see [Network](network.md))
4. Try a different provider to isolate the issue

### Python Bridge Errors

**Symptoms:** "Failed to start Python bridge" or tool execution failures for data engineering tools.

**Solutions:**

1. Check Python is available:
   ```bash
   python3 --version
   ```
2. The bridge looks for Python in this order:
   - `ALTIMATE_CLI_PYTHON` environment variable
   - `.venv/bin/python` in the altimate-engine package directory
   - `.venv/bin/python` in the current working directory
   - `python3` in PATH
3. Ensure required Python packages are installed:
   ```bash
   pip install altimate-engine
   ```

### Warehouse Connection Failed

**Symptoms:** "Connection refused" or authentication errors.

**Solutions:**

1. Test your warehouse credentials outside altimate
2. Check that the warehouse hostname and port are reachable
3. Verify the role/user has the required permissions
4. For Snowflake: ensure the warehouse is not suspended
5. For BigQuery: check that the service account has the required IAM roles

### LSP Server Won't Start

**Symptoms:** No diagnostics or completions for a language.

**Solutions:**

1. Check if the LSP server is disabled:
   ```json
   { "lsp": { "typescript": { "disabled": false } } }
   ```
2. Enable LSP auto-download:
   ```bash
   unset ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD
   ```
3. Check the log files for LSP-specific errors

### Auto-Update Issues

Disable auto-update if it causes problems:

```bash
export ALTIMATE_CLI_DISABLE_AUTOUPDATE=true
```

Or set to notification only:

```json
{
  "autoupdate": "notify"
}
```

### Context Too Large

If conversations hit context limits:

```json
{
  "compaction": {
    "auto": true,
    "prune": true
  }
}
```

Or manually compact in the TUI: leader + `Shift+C`.

## Debug Mode

Run with full debug output:

```bash
altimate --print-logs --log-level DEBUG 2>debug.log
```

Then share `debug.log` when reporting issues.

## Getting Help

- [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues) — Report bugs and request features
- Check [existing issues](https://github.com/AltimateAI/altimate-code/issues) before filing new ones
