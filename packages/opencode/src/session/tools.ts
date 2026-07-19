import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
// altimate_change — shared tool-source stamping so this resolver can't drift from prompt.ts
import { stampRegistryToolSource, describeMcpTool } from "@/altimate/tool-source"
// altimate_change start — upstream_fix: ToolRegistry expects fork-branded model ids here
import { ModelID } from "@/provider/schema"
// altimate_change end
// altimate_change start — HardPolicy enforcement (S3)
import { HardPolicy } from "@/altimate/policy/hard-policy"
// altimate_change end

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    // altimate_change start — upstream_fix: re-brand API model id for ToolRegistry resolution
    modelID: ModelID.make(input.model.api.id),
    // altimate_change end
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            // altimate_change start — HardPolicy enforcement (S3)
            // upstream_fix: plugin.trigger's returned output was previously discarded, so a
            // tool.execute.before hook that mutated `args` had no effect on what actually
            // ran — HardPolicy and execute must see the SAME final, post-hook args.
            const hookOutput = yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const finalArgs = hookOutput.args
            const policyDecision = HardPolicy.check({
              toolID: item.id,
              source: "native",
              args: finalArgs,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            })
            if (!policyDecision.allow) {
              return {
                title: "Blocked by policy",
                output: policyDecision.safeReason,
                metadata: {
                  error: policyDecision.safeReason,
                  hard_policy_denied: true,
                  code: "hard_policy_denied",
                  ruleID: policyDecision.ruleID,
                  success: false,
                },
              }
            }
            // upstream_fix: dispatch the post-hook final args (was `args`).
            const result = yield* item.execute(finalArgs, ctx)
            // altimate_change end
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            // altimate_change — stamp authoritative tool source (shared with prompt.ts resolveTools)
            const stamped = stampRegistryToolSource(output, item)
            yield* plugin.trigger(
              "tool.execute.after",
              // altimate_change start — upstream_fix: after-hook sees the post-hook final args (was `args`)
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args: finalArgs },
              // altimate_change end
              stamped,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, stamped)
            }
            return stamped
          }),
        )
      },
    })
  }

  for (const [key, entry] of Object.entries(yield* mcp.tools())) {
    // altimate_change — split the original client name off the model-facing tool object so it's
    // used only for source classification and never leaks into the tool schema sent to the model.
    const { client: clientName, ...item } = entry
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          // altimate_change start — HardPolicy enforcement (S3)
          // upstream_fix: plugin.trigger's returned output was previously discarded, so a
          // tool.execute.before hook that mutated `args` had no effect on what actually
          // ran — HardPolicy and execute must see the SAME final, post-hook args.
          const hookOutput = yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const finalArgs = hookOutput.args
          const policyDecision = HardPolicy.check({
            toolID: key,
            source: "mcp",
            args: finalArgs,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          })
          if (!policyDecision.allow) {
            return {
              title: "Blocked by policy",
              metadata: {
                error: policyDecision.safeReason,
                hard_policy_denied: true,
                code: "hard_policy_denied",
                ruleID: policyDecision.ruleID,
                success: false,
              },
              output: policyDecision.safeReason,
              attachments: [],
              content: [],
            }
          }
          // altimate_change end
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            // altimate_change start — upstream_fix: dispatch the post-hook final args (was `args`)
            return yield* Effect.promise(() => execute(finalArgs, opts))
            // altimate_change end
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            // altimate_change start — upstream_fix: after-hook sees the post-hook final args (was `args`)
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args: finalArgs },
            // altimate_change end
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          // altimate_change — authoritative source + readable title from the original client name,
          // shared with prompt.ts resolveTools so the two resolvers can't drift.
          const described = describeMcpTool(key, clientName)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
            source: described.source,
          }

          const output = {
            title: described.title,
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
