import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
// altimate_change start — telemetry instrumentation + legacy zod-tool adapter
import z from "zod"
import { Telemetry } from "../altimate/telemetry"
import {
  isLegacyToolDef,
  isLegacyInitFn,
  legacyToInit,
  legacyInitFnToInit,
  type LegacyToolDef,
  type LegacyInitFn,
} from "../altimate/tool-zod-compat"
// altimate_change end
// altimate_change start — humanize tool-call titles at the source
import { describeToolCall } from "../altimate/tool-label"
// altimate_change end

interface Metadata {
  [key: string]: any
  // altimate_change start — standard error field for telemetry extraction
  /** Standard error field — set by tools on failure so telemetry can extract it. */
  error?: string
  // altimate_change end
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. The typed error class makes it matchable upstream, and its `message`
 * getter produces the model-facing prose fed back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

// altimate_change start — upstream_fix: restore caller context for deferred tool init.
export interface InitContext {
  agent?: Agent.Info
}
// altimate_change end

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  // altimate_change start — declared origin so the tool-source badge classifier doesn't have to
  // infer ownership from the id. Only external (user custom / third-party plugin) tools set it;
  // native + Altimate tools omit it and rely on the id fallback. See altimate/tool-source.
  registrySource?: import("../altimate/tool-source").RegistryToolOrigin
  // altimate_change end
  // altimate_change start — upstream_fix: restore caller context for deferred tool init.
  init: (ctx?: InitContext) => Effect.Effect<DefWithoutID<Parameters, M>>
  // altimate_change end
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  // altimate_change start — upstream_fix: restore caller context for deferred tool init.
  | ((ctx?: InitContext) => Effect.Effect<DefWithoutID<Parameters, M>>)
// altimate_change end

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

// altimate_change start — telemetry helpers (ported from the fork's pre-1.17 Tool.define wrapper)
function altimateTrackError(id: string, args: unknown, ctx: Context, startTime: number, error: unknown) {
  try {
    const errorMsg = error instanceof Error ? error.message : String(error)
    const maskedErrorMsg = Telemetry.maskString(errorMsg).slice(0, 500)
    Telemetry.track({
      type: "tool_call",
      timestamp: Date.now(),
      session_id: ctx.sessionID,
      message_id: ctx.messageID,
      tool_name: id,
      tool_type: "standard",
      tool_category: Telemetry.categorizeToolName(id, "standard"),
      status: "error",
      duration_ms: Date.now() - startTime,
      sequence_index: 0,
      previous_tool: null,
      input_signature: Telemetry.computeInputSignature(args as Record<string, unknown>),
      error: maskedErrorMsg,
    })
    Telemetry.track({
      type: "core_failure",
      timestamp: Date.now(),
      session_id: ctx.sessionID,
      tool_name: id,
      tool_category: Telemetry.categorizeToolName(id, "standard"),
      error_class: Telemetry.classifyError(errorMsg),
      error_message: maskedErrorMsg,
      input_signature: Telemetry.computeInputSignature(args as Record<string, unknown>),
      masked_args: Telemetry.maskArgs(args as Record<string, unknown>),
      duration_ms: Date.now() - startTime,
    })
  } catch {
    // Telemetry failure must never mask the original tool error
  }
}

function altimateTrackSuccess(
  id: string,
  args: unknown,
  ctx: Context,
  startTime: number,
  result: ExecuteResult,
) {
  try {
    const isSoftFailure = result.metadata?.success === false
    const durationMs = Date.now() - startTime
    const toolCategory = Telemetry.categorizeToolName(id, "standard")
    // Skip success tool_call for high-volume/low-signal file tools; failures still tracked.
    if (isSoftFailure || toolCategory !== "file") {
      Telemetry.track({
        type: "tool_call",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        message_id: ctx.messageID,
        tool_name: id,
        tool_type: "standard",
        tool_category: toolCategory,
        status: isSoftFailure ? "error" : "success",
        duration_ms: durationMs,
        sequence_index: 0,
        previous_tool: null,
        ...(isSoftFailure && {
          input_signature: Telemetry.computeInputSignature(args as Record<string, unknown>),
        }),
      })
    }
    if (isSoftFailure) {
      // propagate non-string error metadata to avoid blind "unknown error"
      const rawError = result.metadata?.error
      let errorMsg: string
      if (typeof rawError === "string") {
        errorMsg = rawError
      } else if (rawError != null) {
        if (typeof rawError === "object") {
          try {
            errorMsg = Telemetry.maskArgs(rawError as Record<string, unknown>)
          } catch {
            errorMsg = `soft_failure:${id}:unserializable_error`
          }
        } else {
          errorMsg = String(rawError)
        }
      } else {
        errorMsg = `soft_failure:${id}:no_error_metadata`
      }
      const maskedErrorMsg = Telemetry.maskString(errorMsg).slice(0, 500)
      Telemetry.track({
        type: "core_failure",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_name: id,
        tool_category: Telemetry.categorizeToolName(id, "standard"),
        error_class: Telemetry.classifyError(errorMsg),
        error_message: maskedErrorMsg,
        input_signature: Telemetry.computeInputSignature(args as Record<string, unknown>),
        masked_args: Telemetry.maskArgs(args as Record<string, unknown>),
        duration_ms: durationMs,
      })
    }
    // emit sql_quality when successful tools report findings
    const findings = result.metadata?.findings as Telemetry.Finding[] | undefined
    if (!isSoftFailure && Array.isArray(findings) && findings.length > 0) {
      const by_category = Telemetry.aggregateFindings(findings)
      Telemetry.track({
        type: "sql_quality",
        timestamp: Date.now(),
        session_id: ctx.sessionID,
        tool_name: id,
        tool_category: toolCategory,
        finding_count: findings.length,
        by_category: JSON.stringify(by_category),
        has_schema: result.metadata?.has_schema ?? false,
        ...(result.metadata?.dialect && { dialect: result.metadata.dialect as string }),
        duration_ms: durationMs,
      })
    }
  } catch {
    // Telemetry must never break tool execution
  }
}
// altimate_change end

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  // altimate_change start — upstream_fix: pass caller init context through wrappers.
  return (ctx?: InitContext) =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init(ctx)) } : { ...init }
      // altimate_change end
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          // altimate_change start — telemetry instrumentation for tool execution
          const startTime = Date.now()
          const rawResult = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx).pipe(
            Effect.onError((cause) =>
              Effect.sync(() => altimateTrackError(id, decoded, ctx, startTime, Cause.squash(cause))),
            ),
          )
          // humanize the tool-call title at the source so any client (chat webview,
          // TUI, ...) can render a readable label from state.title.
          const result = { ...rawResult, title: describeToolCall(id, decoded, rawResult.title) ?? rawResult.title }
          altimateTrackSuccess(id, decoded, ctx, startTime, result)
          // altimate_change end
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

// altimate_change start — legacy overload: accept old-style zod/Promise tool objects.
// Preserve the zod-inferred parameter type so `Tool.InferParameters<typeof XTool>`
// resolves to `z.infer<P>` (not `unknown`) for run-command display helpers.
export function define<P extends z.ZodType, M extends Metadata = Metadata, ID extends string = string>(
  id: ID,
  legacy: LegacyToolDef<P, M>,
): Effect.Effect<Info<Schema.Decoder<z.infer<P>>, M>, never, Truncate.Service | Agent.Service> & { id: ID }
// legacy overload: accept old-style deferred (async-function) tool factories.
export function define<P extends z.ZodType, M extends Metadata = Metadata, ID extends string = string>(
  id: ID,
  legacy: LegacyInitFn<P, M>,
): Effect.Effect<Info<Schema.Decoder<z.infer<P>>, M>, never, Truncate.Service | Agent.Service> & { id: ID }
// altimate_change end
export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID }
export function define(id: string, init: any): any {
  // altimate_change start — adapt legacy plain-object tool defs (the fork's 77 tools)
  // and legacy deferred (async-function) factories (skill/task/bash).
  const resolvedInit: Effect.Effect<any, never, any> = isLegacyToolDef(init)
    ? legacyToInit(init)
    : isLegacyInitFn(init)
      ? Effect.sync(() => legacyInitFnToInit(init))
      : init
  // altimate_change end
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* resolvedInit
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
  // altimate_change start — upstream_fix: allow callers to initialize with agent context.
  ctx?: InitContext,
  // altimate_change end
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    // altimate_change start — upstream_fix: pass caller init context through Tool.init.
    const init = yield* info.init(ctx)
    // altimate_change end
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
