# Troubleshooting

## Installation

### Standalone binary not found after curl install

**Symptoms:** `altimate-code: command not found` after running `curl -fsSL https://www.altimate.sh/install | bash`.

As of v0.7.1 the curl-installed binary is named `altimate`, not `altimate-code`. The npm package continues to ship both names. If you scripted against the curl install:

```bash
# Before (v0.7.0 and earlier curl install):
~/.altimate-code/bin/altimate-code run "..."

# After (v0.7.1+ curl install):
~/.altimate/bin/altimate run "..."
```

Or stay on the `altimate-code` name by installing via npm: `npm install -g altimate-code`.

### `Cannot find module '@altimateai/altimate-code-core'`

**Symptoms:** Binary crashes on first run with the above error (curl-installed v0.7.0 and earlier).

The v0.7.0 curl install shipped without the NAPI native module. Fixed in v0.7.1 — the native module is now embedded directly into the binary. Re-install with:

```bash
curl -fsSL https://www.altimate.sh/install | bash
```

### Alpine Linux (musl) not supported

**Symptoms:** `Alpine Linux (musl) is not currently supported by the standalone install` during curl install, or `altimate-code is not currently supported on Alpine Linux (musl)` during `npm install` postinstall.

`@altimateai/altimate-core` has no NAPI prebuild for musl. Workarounds:

```bash
# Run the glibc binary under Alpine (recommended):
apk add gcompat

# Then either:
curl -fsSL https://www.altimate.sh/install | bash   # standalone binary
# or:
apk add gcompat && npm install -g altimate-code  # npm install
```

Or use a glibc-based base image (`debian`, `ubuntu`, `node:slim`).

### Windows on ARM64 not supported

**Symptoms:** `altimate-code is not currently built for Windows on ARM64` during install.

Run the x64 build under Windows-on-ARM's x64 emulation layer, or use WSL.

### `altimate` not found after the Windows standalone install

**Symptoms:** `altimate` is unrecognized after running the PowerShell installer.

The installer adds `%USERPROFILE%\.altimate\bin` to your **user** PATH — open a
new terminal so it takes effect. To (re)install or pin a version:

```powershell
# Latest
powershell -c "irm https://www.altimate.sh/install.ps1 | iex"

# Specific version
&([scriptblock]::Create((irm https://www.altimate.sh/install.ps1))) -Version 1.0.180
```

If the binary crashes immediately on an older CPU, the installer normally retries
the baseline (non-AVX2) build automatically; force it with `-ForceBaseline`.

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

### Provider API Errors

**Symptoms:** `APIError: <status>: <message>` shown in chat output. Common forms:

- `APIError: Bad Request: The model 'foo' does not exist or you do not have access to it.`
- `APIError: Unauthorized: Invalid API key`
- `APIError: Rate limit exceeded`

As of v0.7.1, altimate-code surfaces the **inner provider message** instead of dumping the raw JSON body. The status prefix (`Bad Request:`, `Unauthorized:`, etc.) comes from the provider's HTTP status code; everything after the colon is the provider's text verbatim.

**Solutions by error class:**

1. **Model not found** (`APIError: Bad Request: The model '<name>' does not exist...`) — list the models your provider currently exposes and re-run with one of them:
   ```bash
   altimate models <provider>
   ```
   `model_not_found` errors no longer auto-retry; the message you see is the first attempt, not the fifth.
2. **Unauthorized / 401** — re-run `altimate auth login <provider>` and re-issue the request.
3. **Rate limited / 429** — altimate-code automatically retries on rate-limit responses (including plain-text 429s from Alibaba/DashScope). If you keep hitting rate limits, lower `parallel_tool_calls` or switch to a less-saturated model.
4. **Context overflow** — switch to a larger-context model or trim earlier turns with `/compact`. Detection covers Anthropic, Bedrock, OpenAI, Gemini, xAI, Groq, OpenRouter, DeepSeek, Copilot, llama.cpp, LM Studio, MiniMax, Kimi, Moonshot, Azure OpenAI, and HTTP 413.
5. **HTML page returned** — usually a gateway/proxy error. The CLI returns a friendly hint pointing at `altimate auth login` rather than dumping the raw HTML.

**Privacy note:** error messages flow through the same redaction layer as everything else (`sk-…`, `Bearer …`, email addresses, and `*.local` / `*.internal` / RFC1918 / IPv6 loopback / ULA / link-local / AWS IMDS hostnames are masked before reaching telemetry). Internal-host URLs in `metadata.url` are also redacted before they reach local storage or shared sessions, and basic-auth userinfo (`user:pass@…`) is stripped from every URL regardless of whether the host is internal.

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

### Plan mode refuses a benign request, or stops without exploring

**Symptoms:** In plan mode (`--agent plan`), the agent replies *"I'm sorry, but I cannot assist with that request"* to an ordinary planning ask, or you see the warning *"the `plan` agent … stopped without calling any tools."* Most common on the hosted `altimate-default` model (and other non-Anthropic models).

**Solutions:**

1. **Upgrade to v0.8.3 or later.** This was a known bug: altimate-code's internal plan instructions were delivered in a way that non-Anthropic models (GPT-5.x, Gemini, …) could mistake for a prompt-injection attempt and refuse. v0.8.3 delivers them as proper system-role messages, eliminating the refusal.
2. If you still see the agent stop without exploring, follow the in-product warning's recoveries: reply asking it to investigate first (`read`/`grep`/`glob`/`explore`), rephrase the request more concretely, or — if it keeps refusing — `/model` to a tier more eager to explore (e.g. Claude Sonnet/Opus).

### Warehouse Connection Failed

**Symptoms:** "Connection refused", authentication errors, or "No warehouse configured".

**Solutions:**

1. **If using dbt:** Run `/discover` — it automatically finds your `profiles.yml` from `DBT_PROFILES_DIR`, your project directory, or `<home>/.dbt/profiles.yml`. If your `profiles.yml` is in a custom location, set `DBT_PROFILES_DIR` to the directory containing it.
2. **If not using dbt:** Add a connection via the `warehouse_add` tool, `~/.altimate-code/connections.json`, or `ALTIMATE_CODE_CONN_*` env vars.
3. Test connectivity: use the `warehouse_test` tool with your connection name.
4. Check that the warehouse hostname and port are reachable
5. Verify the role/user has the required permissions
6. For Snowflake: ensure the warehouse is not suspended
7. For BigQuery: check that the service account has the required IAM roles

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
