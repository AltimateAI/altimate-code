---
name: altimate-setup
description: Configure Altimate platform credentials for API and workspace access
---

# Altimate Setup

Guide the user through configuring their Altimate platform credentials.

## Steps

1. **Check existing config**: Read `~/.altimate/altimate.json`. If it exists and is valid, show the current config (mask the API key) and ask if they want to update it.

2. **Gather credentials**: Ask the user for:
   - **Altimate URL** (default: `https://api.myaltimate.com`)
   - **Instance name** (their tenant/org name, e.g. `megatenant`)
   - **API key** (from Altimate platform settings)
   - **MCP server URL** (optional, default: `https://mcpserver.getaltimate.com/sse`)

3. **Write config**: Create `~/.altimate/` directory if needed, then write `~/.altimate/altimate.json`:
   ```json
   {
     "altimateUrl": "<url>",
     "altimateInstanceName": "<instance>",
     "altimateApiKey": "<key>",
     "mcpServerUrl": "<mcp-url>"
   }
   ```
   Then set permissions to owner-only: `chmod 600 ~/.altimate/altimate.json`

4. **Validate**: If the `datamate_manager` tool is available, call it with `operation: "list"` to verify the credentials work, and report success or failure to the user. In a project linked to an Altimate workspace, the tool is turned off: ask the user to run `/workspace` → Refresh instead, which calls the Altimate API with these credentials and reports an error if they don't work.
