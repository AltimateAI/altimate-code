import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EOL } from "os"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { basename } from "path"
import { Cause, Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Provider } from "@/provider/provider"
// altimate_change start — upstream_fix: re-brand provider/model ids for debug tool context
import { ModelID, ProviderID } from "@/provider/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
// altimate_change end
import { Session } from "@/session/session"
import type { MessageV2 } from "../../../session/message-v2"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(agent)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const toolCtx = yield* createToolContext(agent, ctx)
    const result = yield* tool.execute(params, toolCtx)
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = {
    ...agent,
    tools: resolvedTools,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const model =
    agent.model ??
    (yield* provider.defaultModel().pipe(
      Effect.matchCauseEffect({
        onSuccess: Effect.succeed,
        onFailure: (cause) => {
          const error = Cause.squash(cause) as Provider.DefaultModelError
          // altimate_change start — upstream_fix: default-model errors now carry ids on data
          if (error instanceof Provider.ModelNotFoundError) {
            return fail(`Model not found: ${error.data.providerID}/${error.data.modelID}`)
          }
          return fail(error instanceof Error ? error.message : "No providers found")
          // altimate_change end
        },
      }),
    ))
  // altimate_change start — upstream_fix: ToolRegistry expects fork-branded provider/model ids
  return yield* registry.tools({
    providerID: ProviderID.make(model.providerID),
    modelID: ModelID.make(model.modelID),
    agent,
  })
  // altimate_change end
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !disabled.has(tool.id)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

const createToolContext = Effect.fn("Cli.debug.agent.createToolContext")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
) {
  const sessionSvc = yield* Session.Service
  const session = yield* sessionSvc.create({ title: `Debug tool run (${agent.name})` })
  const messageID = MessageID.ascending()
  const model = agent.model
    ? agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel().pipe(
          Effect.matchCauseEffect({
            onSuccess: Effect.succeed,
            onFailure: (cause) => {
              const error = Cause.squash(cause) as Provider.DefaultModelError
              // altimate_change start — upstream_fix: default-model errors now carry ids on data
              if (error instanceof Provider.ModelNotFoundError) {
                return fail(`Model not found: ${error.data.providerID}/${error.data.modelID}`)
              }
              return fail(error instanceof Error ? error.message : "No providers found")
              // altimate_change end
            },
          }),
        )
      })
  const now = Date.now()
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    // altimate_change start — upstream_fix: SessionV1 message stores core-branded model/provider ids
    modelID: ModelV2.ID.make(model.modelID),
    providerID: ProviderV2.ID.make(model.providerID),
    // altimate_change end
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: ctx.directory,
      root: ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  const ruleset = Permission.merge(agent.permission, session.permission ?? [])

  return {
    sessionID: session.id,
    messageID,
    callID: PartID.ascending(),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask(req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) {
      return Effect.sync(() => {
        for (const pattern of req.patterns) {
          const rule = Permission.evaluate(req.permission, pattern, ruleset)
          if (rule.action === "deny") {
            throw new PermissionV1.DeniedError({ ruleset })
          }
        }
      })
    },
  }
})
