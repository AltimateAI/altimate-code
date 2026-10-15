# [FEATURE]: Allow plugins to own required MCP server registrations

> Local draft only; nothing posted. Network was unavailable, so an upstream duplicate search remains required. Proposal only; open the issue and obtain design approval before opening an implementation PR.

### Feature hasn't been suggested before.

- [ ] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

A plugin that provides database tools may need an MCP server throughout its lifetime. Please consider an opt-in ownership policy for these registrations, enforced by core and exposed to clients.

In v2.0.29, a plugin can register a server with `ctx.mcp.transform(editor => editor.set("database_tools", config))`, but a client can remove it:

```ts
await opencode.mcp.remove({ server: "database_tools", location: { directory } })
await ctx.mcp.reload()
```

In a local SDK fixture with a real stdio MCP process, the server and its effective tool disappeared and stayed absent after reload. A subsequent prompt requiring that tool was rejected. The runtime removal override prevents the plugin's transform from restoring the server.

Proposed contract:

- Associate an explicitly managed registration with the owning plugin, rather than inferring ownership from its name.
- Reject client removal, disconnection, and replacement of that registration with a descriptive API error. Enforce this in core; clients should display the owner and unavailable actions.
- Allow the owner to update or dispose its registration. Release ownership when the plugin unloads; keep ordinary MCP registrations unchanged.

This needs a core contract because retrying a transform cannot override removal. There is no implementation patch yet. Acceptance coverage should exercise rejected client mutations, owner updates/disposal, same-name conflicts, and ordinary unowned servers.

Code references, verified against **v2.0.29**:

- `packages/plugin/src/promise/mcp.ts:6` and `packages/schema/src/mcp.ts:91`: registration editor and client-visible server shape have no ownership field.
- `packages/protocol/src/groups/mcp.ts:42` and `packages/server/src/handlers/mcp.ts:38`: remove endpoint delegates to core.
- `packages/core/src/mcp/index.ts:660`, `:607`, `:614`: removal override and suppression of subsequent `editor.set`.
- `packages/core/src/mcp/index.ts:635`, `:648`: runtime add/replace and disconnect operations that would need the proposed policy.

### Open questions for maintainers

- Should ownership live on a separate registration handle or the MCP editor contract?
- Should a user override require disabling the owning plugin, or should there be an explicit administrative override?
