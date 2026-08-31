import { cmd } from "./cmd"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
// altimate_change start — upstream_fix: diagnostics surfaced by `mcp status` (#701, #878).
import * as McpDiscover from "../../mcp/discover"
import { ConfigVariable } from "../../config/variable"
// altimate_change end
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance } from "@/project/instance"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect } from "effect"
// altimate_change start — restore removeMcpFromConfig helper used by McpRemoveCommand
import { removeMcpFromConfig } from "../../mcp/config"
// altimate_change end

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      // altimate_change start — upstream_fix (#790): `status` is the name people reach for when a
      // server will not connect, and it was the one name that did not exist. It shares the list
      // handler rather than duplicating a view that already probes live and already prints the
      // failure reason; a `list` alias would widen yargs' alias column and rewrap sibling rows.
      .command({ ...McpListCommand, command: "status", aliases: [], describe: "show MCP server health" })
      // altimate_change end
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      // altimate_change start — restore `mcp remove` removed during v1.4.0 bridge merge
      .command(McpRemoveCommand)
      // altimate_change end
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

// altimate_change start — upstream_fix (#878/#701): config-level diagnostics, shared by every
// exit of `mcp list` / `mcp status` so a config with nothing listable still reports them.
function reportConfigDiagnostics(projectDir: string) {
  // Discovery is first-source-wins, so a server already in altimate-code.json is skipped and a
  // changed .vscode/mcp.json is never mentioned. The configured value still wins; this only
  // says the two disagree and which file to look at.
  for (const { server, source, fields } of McpDiscover.configDrift(projectDir)) {
    prompts.log.warn(`${server} differs from ${source}: ${fields.join(", ")} (config wins)`)
  }

  // A missing `{env:VAR}` becomes "" and the config parses clean, so a blank credential reaches
  // the server and fails much later with an error naming neither. Attribution to a single server
  // is not available here (substitution runs on raw config text, before any structure exists),
  // so this is reported against the file.
  for (const { source, names } of ConfigVariable.blankedEnvVars(projectDir)) {
    prompts.log.warn(`${names.join(", ")} resolved to empty in ${source} (set or remove)`)
  }
}
// altimate_change end

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      // altimate_change start — upstream_fix (#878): drift and blank-variable warnings are about
      // the config, not about any one server, so they must survive the nothing-to-list exit. An
      // enabled-only override for a discovered server leaves this list empty while drift exists.
      reportConfigDiagnostics(Instance.directory)
      // altimate_change end
      // altimate_change start — branding regression
      prompts.outro("Add servers with: altimate mcp add")
      // altimate_change end
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      // altimate_change start — upstream_fix (#701): name variables that resolved to "".
      // A blank `${SNOWFLAKE_PASSWORD}` often connects and only fails on first real use, so
      // this is appended regardless of status rather than only on the failure branch.
      const unresolved = McpDiscover.unresolvedEnvVars(name, Instance.directory)
      if (unresolved.length > 0) {
        hint += "\n    unresolved env: " + unresolved.join(", ") + " (set or remove)"
      }
      // altimate_change end
      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    // altimate_change start — upstream_fix (#878/#701): config-level diagnostics.
    reportConfigDiagnostics(Instance.directory)
    // altimate_change end

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      // altimate_change start — branding regression
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in altimate-code.json:")
      // altimate_change end
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to authenticate",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    // Subscribe to browser open failure events to show URL for manual opening
    const events = yield* EventV2Bridge.Service
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== MCP.BrowserOpenFailed.type) return Effect.void
      const data = event.data as EventV2.Data<typeof MCP.BrowserOpenFailed>
      if (data.mcpName === serverName) {
        spinner.stop("Could not open browser automatically")
        prompts.log.warn("Please open this URL in your browser to authenticate:")
        prompts.log.info(data.url)
        spinner.start("Waiting for authorization...")
      }
      return Effect.void
    })

    yield* MCP.Service.use((mcp) => mcp.authenticate(serverName)).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
      Effect.ensuring(unsubscribe),
    )

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn("No MCP OAuth credentials stored")
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to logout",
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = "tokens + client"
            else if (hasTokens) hint = "tokens"
            else if (hasClient) hint = "client registration"
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      prompts.log.error(`No credentials found for: ${serverName}`)
      prompts.outro("Done")
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(`Removed OAuth credentials for ${serverName}`)
    prompts.outro("Done")
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // altimate_change start — upstream_fix: prefer the fork's primary config filename
  // for new MCP entries while still discovering existing upstream config files.
  const CONFIG_FILENAMES = ["altimate-code.jsonc", "altimate-code.json", "opencode.json", "opencode.jsonc"]
  const candidates: string[] = []

  if (!global) {
    // Subdirectory configs first — .altimate-code is primary, .opencode remains supported.
    candidates.push(
      ...CONFIG_FILENAMES.map((f) => path.join(baseDir, ".altimate-code", f)),
      ...CONFIG_FILENAMES.map((f) => path.join(baseDir, ".opencode", f)),
    )
  }

  candidates.push(...CONFIG_FILENAMES.map((f) => path.join(baseDir, f)))

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to altimate-code.json when nothing exists yet; existing opencode.json/jsonc files are still discovered above.
  return candidates[0]
  // altimate_change end
}

async function addMcpToConfig(name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

export const McpAddCommand = effectCmd({
  command: "add",
  describe: "add an MCP server",
  // altimate_change start — restore explicit non-interactive flags (--name/--type/--url/--command/--env/--header/--oauth/--global)
  // overwritten by v1.4.0 bridge merge, then re-dropped by the v1.17.9 merge (which replaced
  // --name with an `add [name]` positional). Scripts/CI rely on the explicit --name flag to add
  // MCP servers without TTY prompts. Upstream v1.17.9 added its own non-interactive path
  // (--url/--env/--header + command-after-`--`, global-only), but our richer scheme (explicit
  // --name + --type, --command, oauth:false via --no-oauth, project-vs-global via --global/vcs)
  // is the fork contract. Keep it as the primary non-interactive branch; fall through to
  // interactive when --type is absent.
  builder: (yargs) =>
    yargs
      .option("name", { type: "string", describe: "MCP server name" })
      .option("type", { type: "string", describe: "Server type", choices: ["local", "remote"] })
      .option("url", { type: "string", describe: "Server URL (for remote type)" })
      .option("command", { type: "string", describe: "Command to run (for local type)" })
      .option("env", { type: "array", string: true, describe: "Environment variables as key=value (repeatable)" })
      .option("header", { type: "array", string: true, describe: "HTTP headers as key=value (repeatable)" })
      .option("oauth", { type: "boolean", describe: "Enable OAuth", default: true })
      .option("global", { type: "boolean", describe: "Add to global config", default: false }),
  // altimate_change end
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      // altimate_change start — non-interactive mode: upstream v1.17 form (--url or command after --)
      // plus the fork's explicit --type/--command form.
      const passthrough = Array.isArray(args["--"]) ? args["--"] : []
      const inferredType =
        args.type ?? (args.url ? "remote" : passthrough.length > 0 || args.command ? "local" : undefined)
      if (args.name && inferredType) {
        if (!args.name.trim()) {
          console.error("MCP server name cannot be empty")
          process.exitCode = 1
          return
        }

        const useGlobal = args.global || ctx.project.vcs !== "git"
        const configPath = await resolveConfigPath(useGlobal ? Global.Path.config : ctx.worktree, useGlobal)

        let mcpConfig: ConfigMCPV1.Info

        if (inferredType === "local") {
          const command = passthrough.length > 0 ? passthrough : args.command?.trim().split(/\s+/).filter(Boolean)
          if (!command?.length) {
            console.error("A command is required for local type")
            process.exitCode = 1
            return
          }
          const environment: Record<string, string> = {}
          for (const item of (args.env ?? []) as string[]) {
            const eq = item.indexOf("=")
            if (eq === -1) {
              console.error(`Invalid env format: ${item} (expected key=value)`)
              process.exitCode = 1
              return
            }
            environment[item.substring(0, eq)] = item.substring(eq + 1)
          }
          mcpConfig = {
            type: "local",
            command,
            ...(Object.keys(environment).length > 0 ? { environment } : {}),
          }
        } else {
          if (!args.url) {
            console.error("--url is required for remote type")
            process.exitCode = 1
            return
          }
          if (!URL.canParse(args.url)) {
            console.error(`Invalid URL: ${args.url}`)
            process.exitCode = 1
            return
          }

          const headers: Record<string, string> = {}
          if (args.header) {
            for (const h of args.header as string[]) {
              const eq = h.indexOf("=")
              if (eq === -1) {
                console.error(`Invalid header format: ${h} (expected key=value)`)
                process.exitCode = 1
                return
              }
              headers[h.substring(0, eq)] = h.substring(eq + 1)
            }
          }

          mcpConfig = {
            type: "remote",
            url: args.url,
            ...(!args.oauth ? { oauth: false as const } : {}),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          }
        }

        await addMcpToConfig(args.name, mcpConfig, configPath)
        console.log(`MCP server "${args.name}" added to ${configPath}`)
        return
      }
      // altimate_change end

      UI.empty()
      prompts.intro("Add MCP server")

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(ctx.worktree),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Global",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          // altimate_change start — branding regression
          placeholder: "e.g., altimate x @modelcontextprotocol/server-filesystem",
          // altimate_change end
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
        prompts.outro("MCP server added successfully")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            const isValid = URL.canParse(x)
            return isValid ? undefined : "Invalid URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
      }

      prompts.outro("MCP server added successfully")
    })
  }),
})

// altimate_change start — restore `mcp remove` command removed during v1.4.0 bridge merge
export const McpRemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server to remove",
        type: "string",
        demandOption: true,
      })
      .option("global", { type: "boolean", describe: "Remove from global config", default: false }),
  handler: Effect.fn("Cli.mcp.remove")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      const useGlobal = args.global || ctx.project.vcs !== "git"
      const configPath = await resolveConfigPath(useGlobal ? Global.Path.config : ctx.worktree, useGlobal)

      const removed = await removeMcpFromConfig(args.name, configPath)
      if (removed) {
        console.log(`MCP server "${args.name}" removed from ${configPath}`)
      } else if (ctx.project.vcs === "git" && !args.global) {
        const globalPath = await resolveConfigPath(Global.Path.config, true)
        const removedGlobal = await removeMcpFromConfig(args.name, globalPath)
        if (removedGlobal) {
          console.log(`MCP server "${args.name}" removed from ${globalPath}`)
        } else {
          console.error(`MCP server "${args.name}" not found in any config`)
          process.exitCode = 1
          return
        }
      } else if (args.global && ctx.project.vcs === "git") {
        const localPath = await resolveConfigPath(ctx.worktree, false)
        const removedLocal = await removeMcpFromConfig(args.name, localPath)
        if (removedLocal) {
          console.log(`MCP server "${args.name}" removed from ${localPath}`)
        } else {
          console.error(`MCP server "${args.name}" not found in any config`)
          process.exitCode = 1
          return
        }
      } else {
        console.error(`MCP server "${args.name}" not found in any config`)
        process.exit(1)
      }
    })
  }),
})
// altimate_change end

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const mcpServers = config.mcp ?? {}
      const serverName = args.name

      const serverConfig = mcpServers[serverName]
      if (!serverConfig) {
        prompts.log.error(`MCP server not found: ${serverName}`)
        prompts.outro("Done")
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(`MCP server ${serverName} is not a remote server`)
        prompts.outro("Done")
        return
      }

      if (serverConfig.oauth === false) {
        prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
        prompts.outro("Done")
        return
      }

      prompts.log.info(`Server: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)

      // Check stored auth status — services already in hand, run inline.
      const { authStatus, entry } = await Effect.runPromise(
        Effect.all({
          authStatus: mcp.getAuthStatus(serverName),
          entry: auth.get(serverName),
        }),
      )
      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

      if (entry?.tokens) {
        prompts.log.info(`  Access token: ${entry.tokens.accessToken.substring(0, 20)}...`)
        if (entry.tokens.expiresAt) {
          const expiresDate = new Date(entry.tokens.expiresAt * 1000)
          const isExpired = entry.tokens.expiresAt < Date.now() / 1000
          prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? "(EXPIRED)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(`  Refresh token: present`)
        }
      }
      if (entry?.clientInfo) {
        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
        if (entry.clientInfo.clientSecretExpiresAt) {
          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
          prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)
        }
      }

      const spinner = prompts.spinner()
      spinner.start("Testing connection...")

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            ...serverConfig.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              // altimate_change start — branding regression
              clientInfo: { name: "altimate-code-debug", version: InstallationVersion },
              // altimate_change end
            },
            id: 1,
          }),
        })

        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.warn("Server returned 401 Unauthorized")

          // Try to discover OAuth metadata
          const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
          const authProvider = new McpOAuthProvider(
            serverName,
            serverConfig.url,
            {
              clientId: oauthConfig?.clientId,
              clientSecret: oauthConfig?.clientSecret,
              scope: oauthConfig?.scope,
              redirectUri: oauthConfig?.redirectUri,
            },
            {
              onRedirect: async () => {},
            },
            auth,
          )

          prompts.log.info("Testing OAuth flow (without completing authorization)...")

          // Try creating transport with auth provider to trigger discovery
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider,
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
          })

          try {
            const client = new Client({
              // altimate_change start — branding regression
              name: "altimate-code-debug",
              // altimate_change end
              version: InstallationVersion,
            })
            await client.connect(transport)
            prompts.log.success("Connection successful (already authenticated)")
            await client.close()
          } catch (error) {
            if (error instanceof UnauthorizedError) {
              prompts.log.info(`OAuth flow triggered: ${error.message}`)

              // Check if dynamic registration would be attempted
              const clientInfo = await authProvider.clientInformation()
              if (clientInfo) {
                prompts.log.info(`Client ID available: ${clientInfo.client_id}`)
              } else {
                prompts.log.info("No client ID - dynamic registration will be attempted")
              }
            } else {
              prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success("Server responded successfully (no auth required or already authenticated)")
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(`Unexpected status: ${response.status}`)
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.stop("Connection failed", 1)
        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro("Debug complete")
    })
  }),
})
