import z from "zod"
import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import { ProviderID, ModelID } from "../provider/schema"
// altimate_change start — v1.17.9 Tool API: inner tools are Effect-based; run them via AppRuntime
import { AppRuntime } from "../effect/app-runtime"
import type { LegacyContext } from "../altimate/tool-zod-compat"
// altimate_change end
import DESCRIPTION from "./batch.txt"

const DISALLOWED = new Set(["batch"])
const FILTERED_FROM_SUGGESTIONS = new Set(["invalid", "patch", ...DISALLOWED])

// altimate_change start — HardPolicy enforcement (S3)
import { HardPolicy } from "../altimate/policy/hard-policy"
// altimate_change end

// altimate_change start — v1.17.9: BatchTool is a legacy zod/Promise tool (adapted by tool-zod-compat).
// Bridge the Promise-based LegacyContext back into the Effect-based Tool.Context the inner tools expect.
function toEffectContext(ctx: LegacyContext, callID: string): Tool.Context {
  return {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    agent: ctx.agent,
    abort: ctx.abort,
    callID,
    extra: ctx.extra,
    messages: ctx.messages,
    metadata: (input) => Effect.sync(() => ctx.metadata(input)),
    ask: (input) => Effect.promise(() => ctx.ask(input)),
  }
}
// altimate_change end

export const BatchTool = Tool.define("batch", {
  description: DESCRIPTION,
  parameters: z.object({
    tool_calls: z
      .array(
        z.object({
          tool: z.string().describe("The name of the tool to execute"),
          parameters: z.object({}).loose().describe("Parameters for the tool"),
        }),
      )
      .min(1, "Provide at least one tool call")
      .describe("Array of tool calls to execute in parallel"),
  }),
  formatValidationError(error: z.ZodError) {
    const formattedErrors = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root"
        return `  - ${path}: ${issue.message}`
      })
      .join("\n")

    return `Invalid parameters for tool 'batch':\n${formattedErrors}\n\nExpected payload format:\n  [{"tool": "tool_name", "parameters": {...}}, {...}]`
  },
  async execute(params, ctx) {
    const { Session } = await import("../session")
    const { PartID } = await import("../session/schema")

    const toolCalls = params.tool_calls.slice(0, 25)
    const discardedCalls = params.tool_calls.slice(25)

    const { ToolRegistry } = await import("./registry")
    const availableTools = await ToolRegistry.tools({ modelID: ModelID.make(""), providerID: ProviderID.make("") })
    const toolMap = new Map(availableTools.map((t) => [t.id, t]))

    const executeCall = async (call: (typeof toolCalls)[0]) => {
      const callStartTime = Date.now()
      const partID = PartID.ascending()

      try {
        if (DISALLOWED.has(call.tool)) {
          throw new Error(
            `Tool '${call.tool}' is not allowed in batch. Disallowed tools: ${Array.from(DISALLOWED).join(", ")}`,
          )
        }

        const tool = toolMap.get(call.tool)
        if (!tool) {
          const availableToolsList = Array.from(toolMap.keys()).filter((name) => !FILTERED_FROM_SUGGESTIONS.has(name))
          throw new Error(
            `Tool '${call.tool}' not in registry. External tools (MCP, environment) cannot be batched - call them directly. Available tools: ${availableToolsList.join(", ")}`,
          )
        }
        // altimate_change start — v1.17.9: tool.parameters is an Effect Schema, not a zod schema
        const validatedParams = Schema.decodeUnknownSync(tool.parameters)(call.parameters)
        // altimate_change end

        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: partID,
          state: {
            status: "running",
            input: call.parameters,
            time: {
              start: callStartTime,
            },
          },
        })

        // altimate_change start — HardPolicy enforcement (S3)
        // BatchTool's inner dispatch has no tool.execute.before hook, so validatedParams is
        // already the final args seen by both HardPolicy and execute.
        const policyDecision = HardPolicy.check({
          toolID: call.tool,
          source: "batch",
          args: validatedParams,
          sessionID: ctx.sessionID,
          callID: partID,
        })
        if (!policyDecision.allow) {
          throw new Error(policyDecision.safeReason)
        }
        // altimate_change end
        // altimate_change start — v1.17.9: Tool.Def.execute returns an Effect; run via AppRuntime
        const result = await AppRuntime.runPromise(tool.execute(validatedParams, toEffectContext(ctx, partID)))
        // altimate_change end
        const attachments = result.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
        }))

        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: partID,
          state: {
            status: "completed",
            input: call.parameters,
            output: result.output,
            title: result.title,
            metadata: result.metadata,
            attachments,
            time: {
              start: callStartTime,
              end: Date.now(),
            },
          },
        })

        return { success: true as const, tool: call.tool, result }
      } catch (error) {
        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: partID,
          state: {
            status: "error",
            input: call.parameters,
            error: error instanceof Error ? error.message : String(error),
            time: {
              start: callStartTime,
              end: Date.now(),
            },
          },
        })

        return { success: false as const, tool: call.tool, error }
      }
    }

    const results = await Promise.all(toolCalls.map((call) => executeCall(call)))

    // Add discarded calls as errors
    const now = Date.now()
    for (const call of discardedCalls) {
      const partID = PartID.ascending()
      await Session.updatePart({
        id: partID,
        messageID: ctx.messageID,
        sessionID: ctx.sessionID,
        type: "tool",
        tool: call.tool,
        callID: partID,
        state: {
          status: "error",
          input: call.parameters,
          error: "Maximum of 25 tools allowed in batch",
          time: { start: now, end: now },
        },
      })
      results.push({
        success: false as const,
        tool: call.tool,
        error: new Error("Maximum of 25 tools allowed in batch"),
      })
    }

    const successfulCalls = results.filter((r) => r.success).length
    const failedCalls = results.length - successfulCalls

    const outputMessage =
      failedCalls > 0
        ? `Executed ${successfulCalls}/${results.length} tools successfully. ${failedCalls} failed.`
        : `All ${successfulCalls} tools executed successfully.\n\nKeep using the batch tool for optimal performance in your next response!`

    return {
      title: `Batch execution (${successfulCalls}/${results.length} successful)`,
      output: outputMessage,
      attachments: results.filter((result) => result.success).flatMap((r) => r.result.attachments ?? []),
      metadata: {
        totalCalls: results.length,
        successful: successfulCalls,
        failed: failedCalls,
        tools: params.tool_calls.map((c) => c.tool),
        details: results.map((r) => ({ tool: r.tool, success: r.success })),
      },
    }
  },
})
