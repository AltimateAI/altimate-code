export * as ConfigMCPV1 from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  // altimate_change start — dynamic header resolution for short-TTL bearer tokens
  // (e.g. `az account get-access-token`). Each value is an argv array re-run on
  // every connect; values here override matching `headers` keys (case-insensitive).
  // See https://github.com/AltimateAI/altimate-code/issues/791.
  headersCommand: Schema.optional(
    Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String)).check(Schema.isNonEmpty())),
  ).annotate({
    description:
      "Commands to run to resolve dynamic header values (e.g. short-lived bearer tokens). Each value is an argv array run without a shell, re-resolved on every connect. Overrides matching keys in `headers`.",
  }),
  // altimate_change end
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description:
      // altimate_change start — document the auto-disable behavior added for #792
      "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection. OAuth is also automatically skipped when an explicit Authorization header is provided (via `headers` or `headersCommand`) and this field is not explicitly configured.",
    // altimate_change end
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>
