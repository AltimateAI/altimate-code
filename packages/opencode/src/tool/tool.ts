import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import type { SessionID, MessageID } from "../session/schema"
import { Truncate } from "./truncation"
// altimate_change start — telemetry instrumentation for tool execution
import { Telemetry } from "../altimate/telemetry"
// altimate_change end
// altimate_change start — humanize tool-call titles at the source
import { describeToolCall } from "../altimate/tool-label"
// altimate_change end

export namespace Tool {
  interface Metadata {
    [key: string]: any
    // altimate_change start — standard error field for telemetry extraction
    /** Standard error field — set by tools on failure so telemetry can extract it. */
    error?: string
    // altimate_change end
  }

  export interface InitContext {
    agent?: Agent.Info
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: SessionID
    messageID: MessageID
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    messages: MessageV2.WithParts[]
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: string
        attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
      }>
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  // altimate_change start — simplify define() signature, Result generic was unused
  export function define<Parameters extends z.ZodType>(
    id: string,
    init: Info<Parameters>["init"] | Awaited<ReturnType<Info<Parameters>["init"]>>,
  ): Info<Parameters> {
    // altimate_change end
    return {
      id,
      init: async (initCtx) => {
        const original = init instanceof Function ? await init(initCtx) : init
        // Shallow-clone so wrapping execute() doesn't mutate the original tool
        // object across init() calls (each init must yield a distinct object).
        const toolInfo = { ...original }
        const execute = toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
          try {
            toolInfo.parameters.parse(args)
          } catch (error) {
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error), { cause: error })
            }
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
              { cause: error },
            )
          }
          // altimate_change start — telemetry instrumentation for tool execution
          const startTime = Date.now()
          let result: Awaited<ReturnType<typeof execute>>
          try {
            result = await execute(args, ctx)
          } catch (error) {
            // Telemetry must never prevent the original error from propagating
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
            throw error
          }
          // altimate_change start — humanize the tool-call title at the source so any
          // client (chat webview, TUI, ...) can render a readable label from state.title.
          result = { ...result, title: describeToolCall(id, args, result.title) ?? result.title }
          // altimate_change end
          // Telemetry runs after execute() succeeds — wrapped so it never breaks the tool
          try {
            const isSoftFailure = result.metadata?.success === false
            const durationMs = Date.now() - startTime
            const toolCategory = Telemetry.categorizeToolName(id, "standard")
            // Skip success tool_call for file tools (read/write/edit/glob/grep/bash) — high
            // volume, low signal. Failures are still captured via core_failure below.
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
              // prettier-ignore
              // altimate_change start — propagate non-string error metadata to avoid blind "unknown error"
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
              // altimate_change end
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
            // altimate_change start — emit sql_quality when tools report findings
            // Only emit for successful tool runs — soft failures already emit core_failure
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
            // altimate_change end
          } catch {
            // Telemetry must never break tool execution
          }
          // altimate_change end
          // Truncation runs after telemetry so I/O errors from
          // Truncate.output() are not misattributed as tool failures.
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return toolInfo
      },
    }
  }
}
