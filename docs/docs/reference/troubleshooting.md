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

### Tool Execution Errors

**Symptoms:** "No native handler" or tool execution failures for data engineering tools.

**Solutions:**

1. Ensure `@altimateai/altimate-core` is installed (should be automatic):
   ```bash
   npm ls @altimateai/altimate-core
   ```
2. For database tools, ensure the required driver is installed:
   ```bash
   # Example for Snowflake:
   bun add snowflake-sdk
   # Example for PostgreSQL:
   bun add pg
   ```
3. No Python installation is required. All tools run natively in TypeScript.

### Warehouse Connection Failed

**Symptoms:** "Connection refused", authentication errors, or "No warehouse configured".

**Solutions:**

1. **If using dbt:** Run `altimate-dbt init` to set up the dbt integration. The CLI will use your `profiles.yml` automatically, so no separate connection config is needed.
2. **If not using dbt:** Add a connection via the `warehouse_add` tool, `~/.altimate-code/connections.json`, or `ALTIMATE_CODE_CONN_*` env vars.
3. Test connectivity: use the `warehouse_test` tool with your connection name.
4. Check that the warehouse hostname and port are reachable
3. Verify the role/user has the required permissions
4. For Snowflake: ensure the warehouse is not suspended
5. For BigQuery: check that the service account has the required IAM roles

### MCP Server Initialization Failures

**Symptoms:** MCP tools missing or MCP server not available after startup.

**Solutions:**

1. Check the log files. MCP initialization errors are now logged with the server name and error message:
   ```
   WARN failed to initialize MCP server { key: "my-tools", error: "..." }
   ```
2. Verify the MCP server command is correct in your config
3. Test the server manually:
   ```bash
   altimate mcp test my-tools
   ```
4. Check that required environment variables are set (e.g., API keys referenced in the MCP config)

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

Or set to notification only in your config:

```json
{
  "autoupdate": "notify"
}
```

Both options still show an upgrade indicator in the footer when a new version is available. To upgrade manually, run:

```bash
altimate upgrade
```

!!! note
    When an update is available, you'll see `↑ <version> update available · altimate upgrade` in the bottom-right corner of the TUI.

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

- [GitHub Issues](https://github.com/AltimateAI/altimate-code/issues): Report bugs and request features
- Check [existing issues](https://github.com/AltimateAI/altimate-code/issues) before filing new ones
