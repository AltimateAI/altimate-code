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

Altimate Code can read files, write files, and run shell commands, but only with your permission. The [permission system](../configure/permissions.md) lets you control every tool:

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
      "*": "ask",
      "dbt *": "allow",
      "git status": "allow",
      "DROP *": "deny",
      "rm *": "deny"
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
      "*": "ask",
      "DROP *": "deny",
      "DELETE *": "deny",
      "TRUNCATE *": "deny",
      "ALTER *": "deny"
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

1. **A locally accessible LLM**, either a self-hosted model or a provider reachable from your network
2. **Model catalog disabled** by setting `ALTIMATE_CLI_DISABLE_MODELS_FETCH=true` or providing a local models file
3. **Telemetry disabled** by setting `ALTIMATE_TELEMETRY_DISABLED=true`

```bash
export ALTIMATE_CLI_DISABLE_MODELS_FETCH=true
export ALTIMATE_TELEMETRY_DISABLED=true
export ALTIMATE_CLI_MODELS_PATH=/path/to/models.json
```

## What telemetry is collected?

Anonymous usage telemetry, including event names, token counts, timing, and error types. **Never** code, queries, credentials, file paths, or prompt content. See the full [Telemetry reference](telemetry.md) for the complete event list.

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

### How does Altimate Code identify users for analytics?

- **Logged-in users:** Your email is SHA-256 hashed before sending. We never see your raw email.
- **Anonymous users:** A random UUID (`crypto.randomUUID()`) is generated on first run and stored at `~/.altimate/machine-id`. This is NOT tied to your hardware, OS, or identity — it's purely random.
- **Both identifiers** are only sent when telemetry is enabled. Disable with `ALTIMATE_TELEMETRY_DISABLED=true`.
- **No fingerprinting:** We do not use browser fingerprinting, hardware IDs, MAC addresses, or IP-based tracking.

### What happens on first launch?

A single `first_launch` event is sent containing only:

- The installed version (e.g., "0.5.9")
- Whether this is a fresh install or upgrade (boolean)
- Your anonymous machine ID (random UUID)

No code, queries, file paths, or personal information is included. This event helps us understand adoption and is fully opt-out-able.

## What happens when I authenticate via a well-known URL?

When you run `altimate auth login <url>`, the CLI fetches `<url>/.well-known/altimate-code` to discover the server's auth command. Before executing anything:

1. **Validation.** The auth command must be an array of strings. Malformed or unexpected types are rejected.
2. **Confirmation prompt.** You are shown the exact command and must explicitly approve it before it runs.

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
    Third-party MCP servers are not reviewed or audited by Altimate. Treat them like any other third-party dependency: review the source, check for updates, and limit their access.

## What is MCP auto-discovery?

Altimate Code can automatically discover MCP server definitions from other AI tools installed on your machine. This saves you from manually re-configuring servers you already use elsewhere. Sources include:

| Source | Config file | Scope |
|--------|------------|-------|
| VS Code | `.vscode/mcp.json` | Project |
| Cursor | `.cursor/mcp.json` | Project |
| GitHub Copilot | `.github/copilot/mcp.json` | Project |
| Claude Code | `.mcp.json` | Project + Home |
| Gemini CLI | `.gemini/settings.json` | Project + Home |
| Claude Desktop | `~/.claude.json` | Home |

**Security model:**

- **Home-directory configs** (your personal machine config) are treated as trusted and auto-enabled, since you installed them.
- **Project-scoped configs** (checked into a repo) are discovered but **not auto-connected**. They are loaded with `enabled: false` and shown in a notification. Ask the assistant to enable them, or disable auto-discovery entirely with `experimental.auto_mcp_discovery: false`.
- **Sensitive details are redacted** in discovery notifications. Server commands and URLs are only shown when you explicitly inspect them.
- **Prototype pollution, command injection, and path traversal** are hardened against with input validation and `Object.create(null)` result objects.

**To disable auto-discovery entirely:**

```json
{
  "experimental": {
    "auto_mcp_discovery": false
  }
}
```

!!! tip
    If your project repository contains `.vscode/mcp.json` or similar config files from other contributors, auto-discovery will find them but **will not start them** until you approve. Always review discovered servers before enabling them.

## How does the SQL analysis engine work?

As of v0.4.2, all 73 tool methods run natively in TypeScript via `@altimateai/altimate-core` (Rust napi-rs bindings). There is no Python dependency. The engine executes in-process with no subprocess, no network port, and no external service.

## What is `sensitive_write` protection?

Altimate Code classifies writes to credential-adjacent files as `sensitive_write` operations. These always trigger a confirmation prompt, even if `write` is set to `"allow"` in your config. Protected patterns include:

- **Environment files** such as `.env`, `.env.local`, `.env.production`, `.env.staging`
- **Credential files** such as `credentials.json`, `service-account.json`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`
- **Secret key directories** such as `.ssh/`, `.aws/`, `.gnupg/`, `.gcloud/`, `.kube/`, `.docker/`
- **Private key extensions** such as `*.pem`, `*.key`, `*.p12`, `*.pfx`
- **Version control** files such as `.git/config`, `.git/hooks/*`

You can approve per-file with "Allow always" to reduce prompt fatigue. The approval persists for your current session only. On macOS and Windows, matching is case-insensitive.

## Does Altimate Code store conversation history?

Yes. Altimate Code persists session data locally on your machine:

- **Session messages** are stored in a local SQLite database so you can resume, review, and revert conversations.
- **Prompt history** (your recent inputs) is saved to `~/.state/prompt-history.jsonl` for command-line recall.

This data **never** leaves your machine. It is not sent to any service or included in telemetry. You can delete it at any time by removing the local database and history files.

!!! note
    Your LLM provider may have its own data retention policies. Check your provider's terms to understand how they handle API requests.

## How do I secure Altimate Code in a team environment?

1. **Use project-level config.** Place `altimate-code.json` in your project root with appropriate permission defaults. This ensures consistent security settings across the team.

2. **Restrict dangerous operations.** Deny destructive SQL and shell commands at the project level so individual users can't accidentally bypass them.

3. **Use environment variables for secrets.** Never commit credentials. Use `ALTIMATE_CLI_PYTHON`, warehouse connection env vars, and your cloud provider's secret management.

4. **Review MCP servers.** Maintain a list of approved MCP servers. Don't let individual developers add arbitrary servers to shared configurations.

5. **Lock down agent permissions.** Give each agent only the permissions it needs. The `analyst` agent doesn't need `write` access. The `builder` agent doesn't need `DROP` permissions.

## Can AI-generated SQL damage my database?

Altimate Code generates SQL based on your instructions and schema context. Like any generated code, it should be reviewed before execution. The permission system defaults to `"ask"` for shell commands, so you'll see every query before it runs.

For additional safety:

- Use a **read-only database user** for exploration and analysis
- **Deny destructive DDL/DML** via pattern-based permissions
- Run against a **staging environment** before production
- Use the `analyst` agent with restricted permissions for ad-hoc queries

## What protections does Altimate Code have for file access?

Altimate Code includes several layers of protection to keep the agent within your project:

- **Project boundary enforcement.** File operations check that paths stay within your project directory (or git worktree for monorepos). Attempts to read or write outside the project trigger an `external_directory` permission prompt.
- **Symlink-aware path resolution.** Symlinks inside the project that point outside are detected and blocked. This prevents an agent from reading or writing outside your project through symlinks.
- **Path traversal blocking.** Paths containing `../` sequences that would escape the project are rejected with an "Access denied" error.
- **Sensitive file protection.** Writing to credential files (`.env`, `.ssh/`, `.aws/`, private keys) triggers a confirmation prompt, even inside the project. See [below](#why-am-i-being-prompted-to-edit-env-files) for details.
- **Bash command analysis.** The bash tool parses commands with tree-sitter to detect file operations (`rm`, `cp`, `mv`, etc.) targeting paths outside your project, and prompts for permission.
- **Non-git project safety.** For projects outside a git repository, the boundary is strictly the working directory (not the entire filesystem).

These protections operate at the application level. For additional isolation, you can run Altimate Code inside a Docker container or VM.

## Why am I being prompted to edit `.env` files?

Altimate Code prompts before modifying files that commonly contain credentials or security-sensitive configuration, even when they're inside your project. This includes:

| Pattern | Examples |
|---------|----------|
| **Environment files** | `.env`, `.env.local`, `.env.production`, `.env.staging` |
| **Credential files** | `credentials.json`, `service-account.json`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass` |
| **Secret key directories** | `.ssh/`, `.aws/`, `.gnupg/`, `.gcloud/`, `.kube/`, `.docker/` |
| **Private keys** | `*.pem`, `*.key`, `*.p12`, `*.pfx` |
| **Version control** | `.git/config`, `.git/hooks/*` |

When you see this prompt:

- **"Allow once"** approves this single edit
- **"Allow always"** approves edits to this specific file for the rest of the session (resets on restart)

If you frequently edit `.env` files and find the prompts disruptive, click "Allow always" on the first prompt for each file. You won't be asked again for that file during your session.

!!! tip
    This protection does **not** block reading these files, only writing. The agent can still read your `.env` to understand configuration without prompting.

## What commands are blocked or prompted by default?

Altimate Code applies safe defaults so you don't have to configure anything for common protection:

| Command | Default | Why |
|---------|---------|-----|
| `rm -rf *`, `rm -fr *` | **Prompted** | Recursive deletion can be destructive. You'll see what's being deleted. |
| `git push --force *` | **Prompted** | Force-push can overwrite shared branch history. |
| `git reset --hard *` | **Prompted** | Discards uncommitted changes permanently. |
| `git clean -f *` | **Prompted** | Removes untracked files permanently. |
| `DROP DATABASE *` | **Blocked** | Almost never intentional in an agent context. |
| `DROP SCHEMA *` | **Blocked** | Almost never intentional in an agent context. |
| `TRUNCATE *` | **Blocked** | Irreversible data deletion. |
| All other commands | **Prompted** | You approve each command before it runs. |

**"Prompted"** means you'll see the command and can approve or reject it. **"Blocked"** means the agent cannot run it at all; you must override in config.

To override defaults, add rules in `altimate-code.json`. See [Permissions](../configure/permissions.md) for the full configuration reference.

## Best practices for staying safe

1. **Review before approving.** The permission prompt shows you exactly what will happen, including diffs for file edits and the full command for bash. Take a moment to read it.

2. **Work on a branch.** Let the agent work on a feature branch so you can review changes before merging. Git gives you a full safety net. This is the single most effective protection.

3. **Use per-agent permissions.** Give each agent only what it needs. The `analyst` agent doesn't need write access. See [Permissions](../configure/permissions.md) for examples.

4. **Use read-only database credentials for exploration.** When using the agent for analysis or ad-hoc queries, connect with a read-only database user.

5. **Commit before large operations.** If the agent is about to make sweeping changes, commit your current state first. You can always `git stash` or revert.

6. **Block truly dangerous database operations.** The defaults block `DROP DATABASE`, `DROP SCHEMA`, and `TRUNCATE`. You can extend this:

    ```json
    {
      "permission": {
        "bash": {
          "*": "ask",
          "DROP *": "deny",
          "DELETE FROM *": "deny",
          "TRUNCATE *": "deny"
        }
      }
    }
    ```

7. **Use Docker for sensitive environments.** If you're working with production systems or sensitive data, running Altimate Code in a container provides OS-level isolation on top of the permission system.

## Where should I report security vulnerabilities?

**Do not open public GitHub issues for security vulnerabilities.** Instead, email **security@altimate.ai** with a description, reproduction steps, and your severity assessment. You'll receive acknowledgment within 48 hours. See the full [Security Policy](https://github.com/AltimateAI/altimate-code/blob/main/SECURITY.md) for details.
