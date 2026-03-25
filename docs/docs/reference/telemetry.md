# Telemetry

Altimate Code collects anonymous usage data to help us improve the product. This page describes what we collect, why, and how to opt out.

## What We Collect

We collect the following categories of events:

| Event | Description |
|-------|-------------|
| `session_start` | A new CLI session begins |
| `session_end` | A CLI session ends (includes duration) |
| `session_forked` | A session is forked from an existing one |
| `generation` | An AI model generation (step) completes — model ID, provider ID, agent, finish reason, cost, duration, and token breakdown: input, output, and when available: reasoning tokens (reasoning models only), cache-read tokens (prompt cache hit), cache-write tokens (new cache entry). No prompt content. |
| `tool_call` | A tool is invoked (tool name and category — no arguments or output) |
| `native_call` | A native engine call completes (method name and duration — no arguments) |
| `command` | A CLI command is executed (command name only) |
| `error` | An unhandled error occurs (error type and truncated message, but no stack traces) |
| `auth_login` | Authentication succeeds or fails (provider and method, but no credentials) |
| `auth_logout` | A user logs out (provider only) |
| `mcp_server_status` | An MCP server connects, disconnects, or errors (server name and transport) |
| `provider_error` | An AI provider returns an error (error type and HTTP status, but no request content) |
| `engine_started` | The native tool engine initializes (version and duration) |
| `engine_error` | The native tool engine fails to start (phase and truncated error) |
| `upgrade_attempted` | A CLI upgrade is attempted (version and method) |
| `permission_denied` | A tool permission is denied (tool name and source) |
| `doom_loop_detected` | A repeated tool call pattern is detected (tool name and count) |
| `compaction_triggered` | Context compaction runs (strategy and token counts) |
| `tool_outputs_pruned` | Tool outputs are pruned during compaction (count) |
| `environment_census` | Environment snapshot on project scan (warehouse types, dbt presence, feature flags, but no hostnames) |
| `context_utilization` | Context window usage per generation (token counts, utilization percentage, cache hit ratio) |
| `agent_outcome` | Agent session outcome (agent type, tool/generation counts, cost, outcome status) |
| `error_recovered` | Successful recovery from a transient error (error type, strategy, attempt count) |
| `mcp_server_census` | MCP server capabilities after connect (tool and resource counts, but no tool names) |
| `context_overflow_recovered` | Context overflow is handled (strategy) |
| `skill_used` | A skill is loaded (skill name and source — `builtin`, `global`, or `project` — no skill content) |
| `sql_execute_failure` | A SQL execution fails (warehouse type, query type, error message, PII-masked SQL — no raw values) |
| `core_failure` | An internal tool error occurs (tool name, category, error class, truncated error message, PII-safe input signature, and optionally masked arguments — no raw values or credentials) |
| `first_launch` | Fired once on first CLI run after installation. Contains version and is_upgrade flag. No PII. |

Each event includes a timestamp, anonymous session ID, CLI version, and an anonymous machine ID (a random UUID stored in `~/.altimate/machine-id`, generated once and never tied to any personal information).

## Delivery & Reliability

Telemetry events are buffered in memory and flushed periodically. If a flush fails (e.g., due to a transient network error), events are re-added to the buffer for one retry. On process exit, the CLI performs a final flush to avoid losing events from the current session.

No events are ever written to disk. If the process is killed before the final flush, buffered events are lost. This is by design to minimize on-disk footprint.

## Why We Collect Telemetry

Telemetry helps us:

- **Detect errors** by identifying crashes, provider failures, and engine issues before users report them
- **Improve reliability** by tracking MCP server stability, engine initialization, and upgrade outcomes
- **Understand usage patterns** to know which tools and features are used so we can prioritize development
- **Measure performance** by tracking generation latency, tool call duration, and startup time

## Disabling Telemetry

To disable all telemetry collection, add this to your configuration file (`~/.config/altimate-code/altimate-code.json`):

```json
{
  "telemetry": {
    "disabled": true
  }
}
```

You can also set the environment variable:

```bash
export ALTIMATE_TELEMETRY_DISABLED=true
```

When telemetry is disabled, no events are sent and no network requests are made to the telemetry endpoint.

## Privacy

We take your privacy seriously. Altimate Code telemetry **never** collects:

- SQL queries or query results
- Code content, file contents, or file paths
- Credentials, API keys, or tokens
- Database connection strings or hostnames
- Personally identifiable information (your email is SHA-256 hashed before sending and is used only for anonymous user correlation)
- Tool arguments or outputs
- AI prompt content or responses

Error messages are truncated to 500 characters and scrubbed of file paths before sending.

### New User Identification

Altimate Code uses two types of anonymous identifiers for analytics, depending on whether you are logged in:

- **Anonymous users (not logged in):** A random UUID is generated using `crypto.randomUUID()` on first run and stored at `~/.altimate/machine-id`. This ID is not tied to your hardware, operating system, or identity — it is purely random and serves only to distinguish one machine from another in aggregate analytics.
- **Logged-in users (OAuth):** Your email address is SHA-256 hashed before sending. The raw email is never transmitted.

Both identifiers are only sent when telemetry is enabled. Disable telemetry entirely with `ALTIMATE_TELEMETRY_DISABLED=true` or the config option above.

### Data Retention

Telemetry data is sent to Azure Application Insights and retained according to [Microsoft's data retention policies](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure). We do not maintain a separate data store. To request deletion of your telemetry data, contact privacy@altimate.ai.

## Network

Telemetry data is sent to Azure Application Insights:

| Endpoint | Purpose |
|----------|---------|
| `eastus-8.in.applicationinsights.azure.com` | Telemetry ingestion |

For a complete list of network endpoints, see the [Network Reference](network.md).

## For Contributors

### Naming Convention

Event type names use **snake_case** with a `domain_action` pattern:

- `auth_login`, `auth_logout` for authentication events
- `mcp_server_status`, `mcp_server_census` for MCP server lifecycle
- `engine_started`, `engine_error` for native engine events
- `provider_error` for AI provider errors
- `session_forked` for session lifecycle
- `environment_census` for environment snapshot events
- `context_utilization`, `context_overflow_recovered` for context management events
- `agent_outcome` for agent session events
- `error_recovered` for error recovery events

### Adding a New Event

1. **Define the type** — Add a new variant to the `Telemetry.Event` union in `packages/opencode/src/altimate/telemetry/index.ts`
2. **Emit the event** — Call `Telemetry.track()` at the appropriate location
3. **Update docs** — Add a row to the event table above

### Privacy Checklist

Before adding a new event, verify:

- [ ] No SQL, code, or file contents are included
- [ ] No credentials or connection strings are included
- [ ] Error messages are truncated to 500 characters
- [ ] File paths are not included in any field
- [ ] Only tool names are sent, never arguments or outputs
