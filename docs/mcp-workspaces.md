# Workspaces for external coding clients (experimental)

`altimate-code mcp serve --workspace-tools` adds workspace context, named skills and known read operations from the linked workspace's existing `datamate` engine. The default MCP server remains unchanged. This draft builds on the experimental MCP server; no rollout or merge is implied.

The client must run in the intended project directory. Sign-in and linking may complete after connecting: `workspace_context` returns structured setup status and the catalog remains stable. `workspace_context` returns the current workspace, bounded project memory, a summary of skills/knowledge/integrations, and skill names. `workspace_skill` reads a named skill from the validated snapshot; refresh missing skills with `altimate-code workspace refresh`. It rejects traversal, symlinks, oversized skills and a changed snapshot/account.

The engine is pinned with its existing `--datamate` option. Only knowledge, supported metadata reads and SQL reads are exposed; arbitrary tools, writes and engine memory mutations are excluded. SQL uses the existing classifier. Unsupported SQL argument schemas are withheld. The engine authenticates through its normal local configuration. Use read-only warehouse credentials: classification is not database isolation. Local SQL remains available if workspace authentication, linking or engine startup fails. An account/binding change invalidates stale receipts. Read fresh context and use the new receipt; reconnecting MCP is not required.

For non-model clients:

```
altimate-code workspace-client list
altimate-code workspace-client context --directory /absolute/project
printf '%s' 'Use booked ARR for recurring revenue.' | altimate-code workspace-client remember --directory /absolute/project --token=<context-workspace-token> --id=metrics/arr
```

These commands output JSON. A context receipt binds account, workspace and project. `remember` requires that receipt, a valid memory id and 1–2,048 characters on stdin; it saves exactly one project block. It suppresses the ordinary fire-and-forget mirror, then uses the existing sync path with the explicitly selected binding. Requests pin credentials across async API/index operations. A backend failure after local persistence reports `savedLocally: true, cloudConfirmed: false`; retrying is a user decision. Confirmed cloud publication is reported only when the sync reports one successful write. No model-callable memory-write tool or bulk-sync operation is added.

Workspace context adds bounded data to a client's prompt; skills load on demand. Explicit knowledge calls can use backend models, memory publication can invoke the existing backend extractor, and warehouse calls retain warehouse costs. There is no new reasoning agent or per-row model loop. A CLI link can normally backfill existing memory; clients that expose linking without a backfill confirmation must disable memory for that subprocess, as the Claude plugin does. Do not pass `--yes` unless replacing a link was explicitly requested.

Verification covers unit contracts, a real stdio protocol fixture and existing SQLite MCP behavior. Production read-only testing listed visible workspaces and loaded matching context through a temporary local project. Production bindings and memory were not written. A non-empty cloud memory round trip and real workspace-engine SQL/knowledge calls remain rollout checks.

## Automatic-client setup and stable gateway

The opt-in workspace catalog is always `workspace_context`, `workspace_skill` and `workspace_execute`, including when initially unlinked. `workspace_context` reports `needs_auth`, `needs_workspace`, `disabled` or `unavailable` without returning raw credential errors. A ready context includes the workspace receipt. Context loads coalesce and cache for 30 seconds; identity is verified on every use. `refresh: true` bypasses that cache.

Pass `include_tools: true` to request lazy engine discovery. The response includes `engineStatus` (`ready`, `needs_engine` or `unavailable`) and an operation catalog with the engine's actual input schemas. After explicit engine installation, request both `refresh: true` and `include_tools: true`. `workspace_execute` takes `workspace_token`, `operation` and an `arguments` object matching the returned schema. Unknown operations, invalid schemas, stale receipts and source-write SQL are refused. `workspace_skill` also requires `workspace_token`.

This gateway intentionally changes the host permission surface: allowing `workspace_execute` permits its entire closed read-operation allowlist, including knowledge requests that can invoke backend models. It does not inherit per-operation approvals from the old dynamically discovered tool names. No workspace memory write is exposed as an MCP tool.

`workspace-client context` returns the same structured setup status. `workspace-client engine-install` invokes the existing native installer; a UI must require an explicit user action before invoking it. The Claude pilot runs native sign-in and link actions from its first-use panel. Linking disables memory backfill for that subprocess. Authentication output stays outside model context. Default MCP startup without `--workspace-tools` is unchanged.
