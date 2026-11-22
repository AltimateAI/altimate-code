import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
// altimate_change — exact credential values at the alternate tool resolver
import { loadToolCredentialRedactor, type CredentialRedactor } from "@/altimate/tool-output-credentials"
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
// altimate_change start — shared tool-source stamping so this resolver can't drift from prompt.ts
import { stampRegistryToolSource, describeMcpTool } from "@/altimate/tool-source"
// altimate_change end
// altimate_change start — workspace precedence, shared with prompt.ts resolveTools so the
// two resolvers cannot describe the same tool differently. This resolver has no caller in
// the fork today; keeping it in step is insurance against that changing silently.
import * as Precedence from "@/altimate/workspace/precedence"
// altimate_change end
// altimate_change start — upstream_fix: ToolRegistry expects fork-branded model ids here
import { ModelID } from "@/provider/schema"
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

  // altimate_change start — use the same exact-value filter for custom tool results and progress
  const context = (
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
    redact?: CredentialRedactor,
  ): Tool.Context => ({
    redactCredentials: redact,
    // altimate_change end
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    // altimate_change start — pass effective permission rules to search result filtering
    permissions: Permission.merge(input.agent.permission, input.session.permission ?? []),
    // altimate_change end
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            // altimate_change start — sanitize custom tool progress before persistence
            title: redact?.output(val.title) ?? val.title,
            metadata: redact?.output(val.metadata) ?? val.metadata,
            // altimate_change end
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
          // altimate_change start — preserve scoped search read approvals
          ruleset: req.ruleset ?? Permission.merge(input.agent.permission, input.session.permission ?? []),
          // altimate_change end
        })
        .pipe(Effect.orDie),
  })

  // altimate_change start — workspace precedence, derived once per turn from the live map
  const mcpTools = yield* mcp.tools()
  const precedence = yield* Effect.promise(() =>
    Precedence.refresh(
      input.session.id,
      mcpTools,
      Permission.merge(input.agent.permission, input.session.permission ?? []),
    ),
  )
  // altimate_change end

  for (const item of yield* registry.tools({
    // altimate_change start — upstream_fix: re-brand API model id for ToolRegistry resolution
    modelID: ModelID.make(input.model.api.id),
    // altimate_change end
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      // altimate_change start — name the workspace on the native side too
      description: Precedence.describeNativeTool(item.id, item.description, precedence),
      // altimate_change end
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const redact = yield* loadToolCredentialRedactor // altimate_change — collect before tool execution
            const ctx = context(args, options, redact) // altimate_change — protect progress too
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            // altimate_change start — custom and built-in results use the same filter
            const result = redact.output(yield* item.execute(args, ctx))
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
            // altimate_change start — stamp authoritative tool source (shared with prompt.ts resolveTools)
            const stamped = stampRegistryToolSource(output, item)
            // altimate_change end
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              // altimate_change start — plugins observe the source-stamped output
              stamped,
              // altimate_change end
            )
            // altimate_change start — propagate the source-stamped output
            const safeResult = redact.output(stamped)
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, safeResult)
            }
            Tool.assertSuccess(safeResult)
            return safeResult
            // altimate_change end
          }),
        )
      },
    })
  }

  // altimate_change start — split the original client name off the model-facing tool object so
  // it's used only for source classification and never leaks into the schema sent to the model.
  for (const [key, entry] of Object.entries(mcpTools)) {
    const { client: clientName, ...item } = entry
    // altimate_change end
    // altimate_change start — mark the engine tools that now serve a shadowed capability
    item.description = Precedence.describeEngineTool(key, item.description ?? "", precedence)
    // altimate_change end
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          // altimate_change — sanitize before and after the mutable result hook
          let result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
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
          // altimate_change start — before the hook and before text/attachment conversion
          const redact = yield* loadToolCredentialRedactor
          result = redact.output(result)
          // altimate_change end
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          result = redact.output(result) // altimate_change — cover mutable hook changes
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

          const truncated = yield* truncate.output(redact.text(textParts.join("\n\n")), {}, input.agent) // altimate_change — match across joined content
          // altimate_change start — authoritative source + readable title from the original client
          // name, shared with prompt.ts resolveTools so the two resolvers can't drift.
          const described = describeMcpTool(key, clientName)
          // altimate_change end
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
            // altimate_change start — stamp the authoritative source badge
            source: described.source,
            // altimate_change end
          }

          const output = {
            // altimate_change start — MCP tools have no native title; give a readable label
            title: described.title,
            // altimate_change end
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
