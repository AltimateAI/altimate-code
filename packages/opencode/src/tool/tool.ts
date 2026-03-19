import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import type { SessionID, MessageID } from "../session/schema"
import { Truncate } from "./truncation"
// altimate_change start — telemetry instrumentation for tool execution
import { Telemetry } from "../altimate/telemetry"
// altimate_change end

export namespace Tool {
  interface Metadata {
    [key: string]: any
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

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: async (initCtx) => {
        const toolInfo = init instanceof Function ? await init(initCtx) : init
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
              const errorMsg =
                typeof result.metadata?.error === "string"
                  ? result.metadata.error
                  : "unknown error"
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
