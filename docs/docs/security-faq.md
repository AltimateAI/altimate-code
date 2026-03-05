# Security FAQ

Answers to the most common security questions about running Altimate Code in your environment.

---

## Does Altimate Code send my data to external services?

Altimate Code sends prompts and context to the LLM provider you configure (Anthropic, OpenAI, Azure OpenAI, AWS Bedrock, etc.). **You choose the provider.** No data is sent anywhere else except optional [telemetry](#what-telemetry-is-collected), which contains no code, queries, or credentials.

If you use a self-hosted or VPC-deployed model (e.g., AWS Bedrock, Azure OpenAI), your data never leaves your cloud account.

## Can the AI read my database credentials?

Altimate Code needs database credentials to connect to your warehouse. Credentials are stored locally in your project's `altimate-code.json` or passed via environment variables. They are **never** included in telemetry, logged, or sent to any service other than your database.

!!! tip
    Prefer environment variables or your cloud provider's secret manager over hardcoding credentials in config files. Add `altimate-code.json` to `.gitignore` if it contains connection strings.

## What can the agent actually execute?

Altimate Code can read files, write files, and run shell commands — but only with your permission. The [permission system](configure/permissions.md) lets you control every tool:

| Level | Behavior |
|-------|----------|
| `"allow"` | Runs without confirmation |
| `"ask"` | Prompts you before each use |
| `"deny"` | Blocked entirely |

By default, destructive operations like `bash`, `write`, and `edit` require confirmation. You can further restrict specific commands:

```json
{
  "permission": {
    "bash": {
      "dbt *": "allow",
      "git status": "allow",
      "DROP *": "deny",
      "rm *": "deny",
      "*": "ask"
    }
  }
}
```

## Can I prevent the agent from modifying production databases?

Yes. Use pattern-based permissions to deny destructive SQL:

```json
{
  "permission": {
    "bash": {
      "DROP *": "deny",
      "DELETE *": "deny",
      "TRUNCATE *": "deny",
      "ALTER *": "deny",
      "*": "ask"
    }
  }
}
```

You can also configure per-agent permissions. For example, restrict the `analyst` agent to read-only:

```json
{
  "agent": {
    "analyst": {
      "permission": {
        "write": "deny",
        "edit": "deny",
        "bash": {
          "SELECT *": "allow",
          "*": "deny"
        }
      }
    }
  }
}
```

## What network endpoints does Altimate Code contact?

| Destination | Purpose |
|-------------|---------|
| Your configured LLM provider | Model inference |
| Your warehouse endpoints | Database queries |
| `registry.npmjs.org` | Package updates |
| `models.dev` | Model catalog (can be disabled) |
| `eastus-8.in.applicationinsights.azure.com` | Telemetry (can be disabled) |

No other outbound connections are made. See the [Network reference](network.md) for proxy and firewall configuration.

## Can I run Altimate Code without internet access?

Yes, with constraints. You need:

1. **A locally accessible LLM** — self-hosted model or a provider reachable from your network
2. **Model catalog disabled** — set `ALTIMATE_CLI_DISABLE_MODELS_FETCH=true` or provide a local models file
3. **Telemetry disabled** — set `ALTIMATE_TELEMETRY_DISABLED=true`

```bash
export ALTIMATE_CLI_DISABLE_MODELS_FETCH=true
export ALTIMATE_TELEMETRY_DISABLED=true
export ALTIMATE_CLI_MODELS_PATH=/path/to/models.json
```

## What telemetry is collected?

Anonymous usage telemetry — event names, token counts, timing, and error types. **Never** code, queries, credentials, file paths, or prompt content. See the full [Telemetry reference](configure/telemetry.md) for the complete event list.

Disable telemetry entirely:

```json
{
  "telemetry": {
    "disabled": true
  }
}
```

Or via environment variable:

```bash
export ALTIMATE_TELEMETRY_DISABLED=true
```

## What happens when I authenticate via a well-known URL?

When you run `altimate auth login <url>`, the CLI fetches `<url>/.well-known/altimate-code` to discover the server's auth command. Before executing anything:

1. **Validation** — The auth command must be an array of strings. Malformed or unexpected types are rejected.
2. **Confirmation prompt** — You are shown the exact command and must explicitly approve it before it runs.

```
$ altimate auth login https://mcp.example.com
◆ The server requests to run: gcloud auth print-access-token. Allow?
│ ● Yes / ○ No
```

This prevents a malicious server from silently executing arbitrary commands on your machine.

## Are MCP servers a security risk?

MCP (Model Context Protocol) servers extend Altimate Code with additional tools. They run as local subprocesses or connect via SSE/HTTP. Security considerations:

- **Only install MCP servers you trust.** They run with the same permissions as your user account.
- **MCP servers can access your filesystem and network.** Review what a server does before adding it.
- **MCP tool calls go through the permission system.** You can set MCP tools to `"ask"` or `"deny"` like any other tool.

!!! warning
    Third-party MCP servers are not reviewed or audited by Altimate. Treat them like any other third-party dependency — review the source, check for updates, and limit their access.

## How does the Python engine work? Is it safe?

The Python engine (`altimate_engine`) runs as a local subprocess, communicating with the CLI over JSON-RPC via stdio. It:

- Runs under your user account with your permissions
- Has no network access beyond what your warehouse connections require
- Restarts automatically if it crashes (max 2 restarts)
- Times out after 30 seconds per call

The engine is not exposed on any network port — it only communicates through stdin/stdout pipes with the parent CLI process.

## Does Altimate Code store conversation history?

Yes. Altimate Code persists session data locally on your machine:

- **Session messages** are stored in a local SQLite database so you can resume, review, and revert conversations.
- **Prompt history** (your recent inputs) is saved to `~/.state/prompt-history.jsonl` for command-line recall.

This data **never** leaves your machine — it is not sent to any service or included in telemetry. You can delete it at any time by removing the local database and history files.

!!! note
    Your LLM provider may have its own data retention policies. Check your provider's terms to understand how they handle API requests.

## How do I secure Altimate Code in a team environment?

1. **Use project-level config** — Place `altimate-code.json` in your project root with appropriate permission defaults. This ensures consistent security settings across the team.

2. **Restrict dangerous operations** — Deny destructive SQL and shell commands at the project level so individual users can't accidentally bypass them.

3. **Use environment variables for secrets** — Never commit credentials. Use `ALTIMATE_CLI_PYTHON`, warehouse connection env vars, and your cloud provider's secret management.

4. **Review MCP servers** — Maintain a list of approved MCP servers. Don't let individual developers add arbitrary servers to shared configurations.

5. **Lock down agent permissions** — Give each agent only the permissions it needs. The `analyst` agent doesn't need `write` access. The `builder` agent doesn't need `DROP` permissions.

## Can AI-generated SQL damage my database?

Altimate Code generates SQL based on your instructions and schema context. Like any generated code, it should be reviewed before execution. The permission system defaults to `"ask"` for shell commands, so you'll see every query before it runs.

For additional safety:

- Use a **read-only database user** for exploration and analysis
- **Deny destructive DDL/DML** via pattern-based permissions
- Run against a **staging environment** before production
- Use the `analyst` agent with restricted permissions for ad-hoc queries

## Where should I report security vulnerabilities?

**Do not open public GitHub issues for security vulnerabilities.** Instead, email **security@altimate.ai** with a description, reproduction steps, and your severity assessment. You'll receive acknowledgment within 48 hours. See the full [Security Policy](https://github.com/AltimateAI/altimate-code/blob/main/SECURITY.md) for details.
