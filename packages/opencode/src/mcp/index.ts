import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { type Tool } from "ai"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
// altimate_change start — makeRuntime for the restored Promise wrappers (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  ListRootsRequestSchema,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { NamedError } from "@opencode-ai/core/util/error"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
// altimate_change start — needed to resolve `headersCommand` for remote MCP
// servers that require bearer tokens with short TTLs (Microsoft Fabric, etc.) (#791)
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)
// altimate_change end
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { TuiEvent } from "@/server/tui-event"
import open from "open"
import { Cause, Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
// altimate_change start — effect@4 renamed Either → Result (Effect.either → Effect.result)
import * as Result from "effect/Result"
// altimate_change end
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
// altimate_change start — persist enabled flag + telemetry
import { findAllConfigPaths, listMcpInConfig, addMcpToConfig, readMcpEntryFromDisk } from "./config"
import { Global } from "@opencode-ai/core/global"
import { Telemetry } from "@/telemetry"
import { Log } from "../util/log"
// altimate_change end

const DEFAULT_TIMEOUT = 30_000
// altimate_change start — upstream_fix: logger to drain local MCP server stderr (see connectLocal)
const log = Log.create({ service: "mcp" })
// altimate_change end
const CLIENT_OPTIONS = {
  capabilities: {
    // altimate_change start — upstream issue-tracker references (capabilities pending upstream); acknowledged, not a brand leak
    // https://github.com/anomalyco/opencode/issues/11948
    // sampling: {},
    // https://github.com/anomalyco/opencode/issues/23066
    // elicitation: {},
    // https://github.com/anomalyco/opencode/issues/2308
    roots: {},
    // https://github.com/anomalyco/opencode/issues/28567
    // tasks: {},
    // altimate_change end
  },
} satisfies ClientOptions

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = EventV2.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
})

export const BrowserOpenFailed = EventV2.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

function createClient(directory: string) {
  // altimate_change start — brand client name as altimate
  const client = new Client({ name: "altimate", version: InstallationVersion }, CLIENT_OPTIONS)
  // altimate_change end
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// altimate_change start — upstream_fix: do not swallow the connect error (#1121).
// The failure path already carries the real message — `401 Unauthorized`, a transport
// error, `Invalid MCP URL for "<key>"` — in `status.error`, but the warning logged only
// `status.status`, which is the constant string "failed". An external user had to read
// this source to find out why their server would not connect.
//
// Split out as a pure function so the payload is testable without standing up a
// transport, and so a future edit cannot quietly drop the field again.
export function unavailableLogFields(
  key: string,
  type: string,
  status: Status,
): { key: string; type: string; status: string; error?: string } {
  const error = "error" in status && typeof status.error === "string" ? status.error : undefined
  return error ? { key, type, status: status.status, error } : { key, type, status: status.status }
}
// altimate_change end

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

// altimate_change start — telemetry transport label type
type TransportLabel = "stdio" | "sse" | "streamable-http"
// altimate_change end

// altimate_change start — internal test hooks for headersCommand resolution (#791/#792)
/** @internal — exported only for unit tests. Prefer using `tools()` in production code. */
export const _testing = {
  resolveHeadersCommand: (spec: Record<string, string[]> | undefined, key = "test") =>
    resolveHeadersCommand(spec, key),
  hasAuthorizationHeader,
  mergeHeaders,
}
// altimate_change end

// altimate_change start — resolve dynamic header values from argv commands
// (e.g. `az account get-access-token`). Each value is an argv array run via
// execFile (no shell) so values aren't subject to shell injection. Re-runs on
// every connect so expiring bearer tokens refresh without manual config edits.
// See https://github.com/AltimateAI/altimate-code/issues/791.
async function resolveHeadersCommand(
  spec: Record<string, string[]> | undefined,
  serverKey: string,
): Promise<Record<string, string>> {
  if (!spec) return {}
  const out: Record<string, string> = {}
  for (const [name, argv] of Object.entries(spec)) {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error(`headersCommand[${name}] must be a non-empty argv array`)
    }
    const [cmd, ...args] = argv
    let stdout = ""
    try {
      stdout = (
        await execFileAsync(cmd, args, {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
        })
      ).stdout
    } catch (err) {
      // Wrap with the header key so `mcp list` points to the exact failing
      // command (ENOENT, timeout, non-zero exit) rather than a bare error.
      // On a non-zero exit the actionable reason lives on `err.stderr` (e.g.
      // `az`'s "run 'az login'"), which `err.message` omits — append it.
      // The composed message is masked before it escapes: execFile's message
      // echoes the full argv and an auth CLI run with --verbose can print the
      // token to stderr, and this string reaches logs and the status API.
      // Over-masking (quoted spans become `?`) is the correct failure mode.
      const e = err as { message?: string; stderr?: string }
      const stderr = typeof e.stderr === "string" ? e.stderr.trim().slice(0, 500) : ""
      const base = err instanceof Error ? err.message : String(err)
      const message = Telemetry.maskString(stderr ? `${base}: ${stderr}` : base)
      throw new Error(`headersCommand[${name}] failed: ${message}`)
    }
    const value = stdout.trim()
    if (!value) {
      throw new Error(`headersCommand[${name}] produced empty output`)
    }
    log.info("resolved dynamic header", { server: serverKey, header: name })
    out[name] = value
  }
  return out
}

// Accepts any header-shaped record (static `headers` values are strings,
// `headersCommand` values are argv arrays) — only key names are inspected.
function hasAuthorizationHeader(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
}

// HTTP header names are case-insensitive, so a dynamic header must replace a
// static one that differs only in casing (`headers.Authorization` +
// `headersCommand.authorization` would otherwise both be sent — duplicate
// credentials some servers reject). Dynamic values win under the documented
// contract: "Values from headersCommand override matching keys in `headers`."
function mergeHeaders(
  staticHeaders: Record<string, string>,
  dynamicHeaders: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...staticHeaders }
  for (const [name, value] of Object.entries(dynamicHeaders)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing]
    }
    merged[name] = value
  }
  return merged
}
// altimate_change end

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  // altimate_change start — carry transport label for census telemetry
  transport?: TransportLabel
  // altimate_change end
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  // altimate_change start — carry the original (pre-sanitize) client name so tool-source
  // classification works from the real name, not the flattened `<client>_<tool>` key
  // (see altimate/tool-source).
  readonly tools: () => Effect.Effect<Record<string, Tool & { client: string }>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  // altimate_change end
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  // altimate_change start — MCP.remove: full runtime teardown + ToolsChanged (merge dropped it)
  readonly remove: (name: string) => Effect.Effect<void>
  // altimate_change end
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

// altimate_change start — fire-and-forget census telemetry. Do not perform extra
// MCP list requests here; resource/prompt/tool listing is observable server I/O
// and is already capability-gated on the normal access paths.
function trackCensus(key: string, transport: TransportLabel, toolCount: number) {
  Telemetry.track({
    type: "mcp_server_census",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    server_name: key,
    transport,
    tool_count: toolCount,
    resource_count: 0,
  })
}
// altimate_change end

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient(directory)
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
    ) {
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
          transport: undefined as TransportLabel | undefined,
        }
      }

      // altimate_change start — resolve dynamic headers (e.g. bearer tokens produced
      // by `az account get-access-token`) before constructing transports. Failure to
      // resolve aborts the connect attempt; the thrown message already names the
      // failing header (`headersCommand[<name>] failed: ...`), so the user sees
      // exactly which command broke in `mcp list`.
      // See https://github.com/AltimateAI/altimate-code/issues/791.
      const dynamicHeadersResult = yield* Effect.tryPromise({
        try: () => resolveHeadersCommand(mcp.headersCommand, key),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.result)
      if (Result.isFailure(dynamicHeadersResult)) {
        const message = dynamicHeadersResult.failure.message
        yield* Effect.logError("headersCommand resolution failed", { key, error: message })
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: message },
          transport: undefined as TransportLabel | undefined,
        }
      }
      const mergedHeaders = mergeHeaders(mcp.headers ?? {}, dynamicHeadersResult.success)
      // altimate_change end

      // altimate_change start — OAuth is enabled by default for remote servers,
      // BUT if the user provided an explicit Authorization header (statically or
      // via headersCommand) and didn't ask for OAuth, skip OAuth so the bearer
      // header isn't pre-empted by an OAuth flow that fails (e.g. Microsoft
      // Entra ID rejects RFC 7591 dynamic client registration).
      // See https://github.com/AltimateAI/altimate-code/issues/792.
      const oauthExplicitlyDisabled = mcp.oauth === false
      const oauthExplicitlyConfigured = typeof mcp.oauth === "object"
      const oauthDisabled =
        oauthExplicitlyDisabled || (!oauthExplicitlyConfigured && hasAuthorizationHeader(mergedHeaders))
      // altimate_change end
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      // altimate_change start — pass merged (static + dynamic) headers to transports
      const requestInit = Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : undefined
      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit,
          }),
        },
      ]
      // altimate_change end

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        // altimate_change start — telemetry: time each transport attempt
        const connectStart = Date.now()
        const transportLabel: TransportLabel = name === "SSE" ? "sse" : "streamable-http"
        // altimate_change end
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    // altimate_change start — brand CLI name in auth hint
                    message: `Server "${key}" requires authentication. Run: altimate mcp auth ${key}`,
                    // altimate_change end
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            lastStatus = { status: "failed" as const, error: lastError.message }
            // altimate_change start — telemetry: non-auth transport connect error
            Telemetry.track({
              type: "mcp_server_status",
              timestamp: Date.now(),
              session_id: Telemetry.getContext().sessionId,
              server_name: key,
              transport: transportLabel,
              status: "error",
              error: lastError.message.slice(0, 500),
              duration_ms: Date.now() - connectStart,
            })
            // altimate_change end
            return Effect.void
          }),
        )
        if (result) {
          // altimate_change start — telemetry: successful remote connect
          Telemetry.track({
            type: "mcp_server_status",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId,
            server_name: key,
            transport: transportLabel,
            status: "connected",
            duration_ms: Date.now() - connectStart,
          })
          // altimate_change end
          return { client: result.client, status: { status: "connected" } as Status, transport: transportLabel }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
        transport: undefined as TransportLabel | undefined,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const baseDir = yield* InstanceState.directory
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          // altimate_change start — brand: BUN_BE_BUN for altimate/altimate-code self-spawn
          ...(cmd === "opencode" || cmd === "altimate" || cmd === "altimate-code" ? { BUN_BE_BUN: "1" } : {}),
          // altimate_change end
          // altimate_change start — env-var references in mcp.environment are resolved once
          // at config load time: `ConfigPaths.substitute()` for `opencode.json`, and
          // `resolveServerEnvVars()` for discovered external configs (`.vscode/mcp.json`,
          // `.cursor/mcp.json`, etc.). A second pass here would re-expand already-resolved
          // values and break the `$${VAR}` escape convention — see PR #666 review.
          ...mcp.environment,
          // altimate_change end
        },
      })
      // altimate_change start — upstream_fix: drain the local server's stderr. With `stderr: "pipe"`
      // and no consumer, a chatty MCP server fills the OS pipe buffer (~64KiB) and blocks the child,
      // hanging connect and every subsequent tool call. Consume (and log) it as main did.
      transport.stderr?.on("data", (chunk: Buffer) => log.info(`mcp stderr: ${chunk.toString().trimEnd()}`, { key }))
      // altimate_change end

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      // altimate_change start — telemetry: time the local startup
      const localConnectStart = Date.now()
      // altimate_change end
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status; transport: TransportLabel } => {
          // altimate_change start — telemetry: successful local connect
          Telemetry.track({
            type: "mcp_server_status",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId,
            server_name: key,
            transport: "stdio",
            status: "connected",
            duration_ms: Date.now() - localConnectStart,
          })
          // altimate_change end
          return {
            client,
            status: { status: "connected" },
            transport: "stdio",
          }
        }),
        Effect.catch(
          (error): Effect.Effect<{ client: MCPClient | undefined; status: Status; transport?: TransportLabel }> => {
            const msg = error instanceof Error ? error.message : String(error)
            // altimate_change start — telemetry: local startup error
            Telemetry.track({
              type: "mcp_server_status",
              timestamp: Date.now(),
              session_id: Telemetry.getContext().sessionId,
              server_name: key,
              transport: "stdio",
              status: "error",
              error: msg.slice(0, 500),
              duration_ms: Date.now() - localConnectStart,
            })
            // altimate_change end
            return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
          },
        ),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: ConfigMCPV1.Info) {
        if (mcp.enabled === false) {
          return DISABLED_RESULT
        }

        const {
          client: mcpClient,
          status,
          transport,
        } =
          mcp.type === "remote"
            ? yield* connectRemote(key, mcp as ConfigMCPV1.Info & { type: "remote" })
            : yield* connectLocal(key, mcp as ConfigMCPV1.Info & { type: "local" })

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            // altimate_change start — upstream_fix: include the real error (#1121).
            yield* Effect.logWarning("server unavailable", unavailableLogFields(key, mcp.type, status))
            // altimate_change end
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          // altimate_change — McpCatalog.defs() tolerates both outputSchema
          // reference errors and Fabric-style null annotation hints (#792).
          const listed = mcpClient.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(mcpClient, mcp.timeout)
            : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          // altimate_change start — fire-and-forget census telemetry once tools are listed
          if (transport) trackCensus(key, transport, listed.length)
          // altimate_change end
          return { mcpClient, status, defs: listed, transport } satisfies CreateResult
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
          ),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        // altimate_change — matches create(): McpCatalog.defs() tolerates
        // annotation-null tools on a live tool-list refresh (#792).
        const listed = await bridge.promise(McpCatalog.defs(client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
        }

        // altimate_change start — auto-discover MCP servers from external AI tool configs
        let discoveryResult: { serverNames: string[]; sources: string[] } | null = null
        try {
          const { consumeDiscoveryResult } = yield* Effect.promise(() => import("./discover"))
          discoveryResult = consumeDiscoveryResult()
        } catch {
          // Discovery module not loaded — skip
        }
        // altimate_change end

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                yield* Effect.logError("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp)
              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        // altimate_change start — show discovery toast + telemetry after MCP connections complete
        if (discoveryResult) {
          const message = `Discovered ${discoveryResult.serverNames.length} new MCP server(s): ${discoveryResult.serverNames.join(", ")}. Ask the assistant to add them, or they will be available automatically in the current session.`
          yield* events
            .publish(TuiEvent.ToastShow, {
              title: "MCP Servers Discovered",
              message,
              variant: "info",
              duration: 8000,
            })
            .pipe(Effect.ignore)
          Telemetry.track({
            type: "mcp_discovery",
            timestamp: Date.now(),
            session_id: Telemetry.getContext().sessionId,
            server_count: discoveryResult.serverNames.length,
            server_names: discoveryResult.serverNames,
            sources: discoveryResult.sources,
          })
        }
        // altimate_change end

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = Object.values(s.clients)
            s.clients = {}
            s.defs = {}
            yield* Effect.forEach(
              clients,
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  // altimate_change — log close failures instead of silently ignoring, so a leaked
                  // MCP child/socket is diagnosable (main logged "Failed to close MCP client").
                  yield* Effect.tryPromise(() => client.close()).pipe(
                    Effect.catch((e: unknown) => Effect.logWarning("failed to close MCP client", { error: String(e) })),
                  )
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      const previous = s.clients[name]
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      if (previous) yield* Effect.tryPromise(() => previous.close()).pipe(Effect.ignore)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      s.config[name] = mcp
      yield* createAndStore(name, mcp)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* createAndStore(name, { ...mcp, enabled: true })
      // altimate_change start — persist enabled:true so it survives session restarts
      yield* persistMcpEnabled(name, true)
      // altimate_change end
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      // altimate_change start — telemetry: explicit disconnect
      const transport: TransportLabel =
        s.clients[name]?.transport instanceof StdioClientTransport ? "stdio" : "streamable-http"
      // altimate_change end
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
      // altimate_change start — telemetry + persist enabled:false so disable survives restarts
      Telemetry.track({
        type: "mcp_server_status",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        server_name: name,
        transport,
        status: "disconnected",
      })
      yield* persistMcpEnabled(name, false)
      // altimate_change end
    })

    // altimate_change start — restore MCP.remove dropped by the v1.17.9 merge. Fully removes a server
    // from RUNTIME state: closes the client, DELETES the status entry (not just marks it "disabled"),
    // and publishes ToolsChanged so the agent's live tool list and the /mcps view refresh. The datamate
    // delete/remove flows use this; plain disconnect leaves a stale "disabled" entry and never publishes
    // ToolsChanged, so the agent keeps offering tools from a removed server until the next restart.
    const remove = Effect.fn("MCP.remove")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      delete s.status[name]
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })
    // altimate_change end

    // altimate_change start — persist enabled/disabled to disk so it survives session restarts.
    // Serialize all writes: persistMcpEnabled is read-modify-write on a shared config file, so
    // concurrent callers (e.g. rapid /mcps enable then disable) could otherwise interleave and
    // clobber each other's changes. Returns an Effect that wraps the serialized Promise chain.
    let persistChain: Promise<void> = Promise.resolve()
    const persistMcpEnabled = (name: string, enabled: boolean) =>
      Effect.gen(function* () {
        const directory = yield* InstanceState.directory
        yield* Effect.promise(() => {
          const run = persistChain.then(() =>
            persistMcpEnabledUnlocked(name, enabled, directory, Global.Path.config),
          )
          persistChain = run.catch(() => {})
          return run
        })
      })
    async function persistMcpEnabledUnlocked(
      name: string,
      enabled: boolean,
      directory: string,
      globalConfig: string,
    ): Promise<void> {
      try {
        const paths = await findAllConfigPaths(directory, globalConfig)
        let found = false
        for (const p of paths) {
          const names = await listMcpInConfig(p)
          if (names.includes(name)) {
            const entry = await readMcpEntryFromDisk(name, p)
            if (entry)
              await addMcpToConfig(name, { ...entry, enabled } as Parameters<typeof addMcpToConfig>[1], p)
            found = true
            break
          }
        }
        if (!found) {
          // altimate_change — log instead of silently dropping, so a reverted-after-restart enabled
          // flag is diagnosable (main logged "entry not found").
          log.warn("mcp enabled flag not persisted: server not found in any config file", { name, enabled })
        }
      } catch (e) {
        // altimate_change — log the write failure instead of silently swallowing it (main logged it).
        log.warn("failed to persist mcp enabled flag", {
          name,
          enabled,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    // altimate_change end

    const disconnectOld = undefined // placeholder removed

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return s.config[name]?.timeout ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      // altimate_change start — values carry the original client name (see Interface.tools).
      const result: Record<string, Tool & { client: string }> = {}
      // altimate_change end
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        for (const mcpTool of listed) {
          const key = McpCatalog.sanitize(clientName) + "_" + McpCatalog.sanitize(mcpTool.name)
          // altimate_change start — attach the original client name for source classification downstream.
          result[key] = Object.assign(McpCatalog.convertTool(mcpTool, client, timeout), { client: clientName })
          // altimate_change end
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return yield* Effect.forEach(
          Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
          ([clientName, client]) =>
            McpCatalog.fetch(
              clientName,
              client,
              (c) => listFn(c, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
              label,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.resources, "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      // TODO(merge-964): this manual-OAuth-flow transport does not resolve
      // `mcp.headersCommand` or merge it with `mcp.headers` before constructing
      // the transport, unlike connectRemote(). The original #793 patch did not
      // touch this call site either. Static `headers` are still passed through
      // unchanged, but a user relying solely on `headersCommand` for a server
      // that also needs a manual OAuth flow will not have it applied here.
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
      })
      const directory = yield* InstanceState.directory

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )

        // altimate_change — McpCatalog.defs() tolerates annotation-null tools so
        // they don't block the post-OAuth connect from completing (#792).
        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(client, mcpConfig.timeout)
            : []
          : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } satisfies Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") return false
      if (mcpConfig.oauth === false) return false
      if (typeof mcpConfig.oauth === "object") return true
      // altimate_change start — mirror connectRemote()'s auto-disable: when the user
      // provided an Authorization header (statically or via headersCommand) and
      // didn't explicitly configure OAuth, connect-time skips OAuth — so the auth
      // API surface must not advertise it, or `POST /:name/auth` would start an
      // OAuth flow whose tokens the connection never uses. headersCommand is not
      // resolved here (that would execute the command); the presence of an
      // Authorization key in its spec is enough to know connect-time disables OAuth.
      // See https://github.com/AltimateAI/altimate-code/issues/792.
      return !hasAuthorizationHeader({ ...(mcpConfig.headers ?? {}), ...(mcpConfig.headersCommand ?? {}) })
      // altimate_change end
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated"
      const expired = yield* auth.isTokenExpired(mcpName)
      return expired ? "expired" : "authenticated"
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      // altimate_change start — MCP.remove (merge dropped it)
      remove,
      // altimate_change end
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(
  Layer.provide(McpAuth.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node])
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration. Our datamate/mcp-discover tools call these from plain async code; the
// makeRuntime bridge keeps reads/mutations bound to the active workspace/instance.
const { runPromise: runMcp } = makeRuntime(Service, defaultLayer)
export async function status() {
  return runMcp((svc) => svc.status())
}
export async function tools() {
  return runMcp((svc) => svc.tools())
}
export async function add(name: string, mcp: ConfigMCPV1.Info) {
  return runMcp((svc) => svc.add(name, mcp))
}
export async function connect(name: string) {
  return runMcp((svc) => svc.connect(name))
}
export async function disconnect(name: string) {
  return runMcp((svc) => svc.disconnect(name))
}
// altimate_change start — MCP.remove namespace wrapper (full runtime teardown + ToolsChanged)
export async function remove(name: string) {
  return runMcp((svc) => svc.remove(name))
}
// altimate_change end
export async function readResource(clientName: string, resourceUri: string) {
  return runMcp((svc) => svc.readResource(clientName, resourceUri))
}
export async function supportsOAuth(mcpName: string) {
  return runMcp((svc) => svc.supportsOAuth(mcpName))
}
export async function startAuth(mcpName: string) {
  return runMcp((svc) => svc.startAuth(mcpName))
}
export async function finishAuth(mcpName: string, authorizationCode: string) {
  return runMcp((svc) => svc.finishAuth(mcpName, authorizationCode))
}
export async function authenticate(mcpName: string) {
  return runMcp((svc) => svc.authenticate(mcpName))
}
export async function removeAuth(mcpName: string) {
  return runMcp((svc) => svc.removeAuth(mcpName))
}
export async function resources() {
  return runMcp((svc) => svc.resources())
}
// altimate_change end

export * as MCP from "."
