# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

Altimate Code is an AI-powered data engineering coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Permission System

Altimate Code includes a permission system that prompts for confirmation before the agent executes commands, writes files, or accesses resources outside your project. You can configure each tool as `"allow"`, `"ask"`, or `"deny"` — and use pattern-based rules to fine-tune behavior (e.g., allow `dbt run` but deny `rm *`).

The permission system is designed to keep you informed and in control of what the agent does. It includes:

- **Per-tool and per-pattern controls** with wildcard matching
- **Per-agent permission overrides** (e.g., restrict `analyst` to read-only)
- **External directory detection** that prompts when the agent accesses files outside your project
- **Path traversal protection** that blocks attempts to escape the project directory
- **Doom loop detection** that alerts you when the agent repeats failed actions

However, the permission system operates at the application level. It does not provide OS-level sandboxing — the process runs with your user permissions. For high-security environments or when working with sensitive production systems, we recommend running Altimate Code inside a Docker container or VM for additional isolation.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server — any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/AltimateAI/altimate-code/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may send an email to security@altimate.ai
