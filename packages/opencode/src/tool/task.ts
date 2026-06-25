import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
// altimate_change start — upstream_fix: publish a task schema that hides disabled background mode.
import { zodToJsonSchema } from "@/altimate/tool-zod-compat"
// altimate_change end
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
// altimate_change start — log unhandled cancel rejections
import { Log } from "@/util/log"
// re-brand core (ModelV2/ProviderV2) IDs to the provider/schema brands SessionPrompt expects
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"
const log = Log.create({ service: "tool.task" })

/**
 * Effect-based prompt operations the task tool drives through `ctx.extra.promptOps`.
 * Injected by session/tools so the tool stays decoupled from SessionPrompt's
 * concrete service and is straightforward to stub in tests.
 */
export interface TaskPromptOps {
  readonly resolvePromptParts: (template: string) => Effect.Effect<SessionPrompt.PromptInput["parts"]>
  readonly prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
}
// altimate_change end

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  // altimate_change start — upstream_fix: keep accepting legacy/manual background calls internally.
  background: z.boolean().optional(),
  // altimate_change end
})

// altimate_change start — upstream_fix: keep accepting `background` internally so old/manual
// callers get the explicit disabled-feature error, but do not advertise it to models.
const taskJsonSchema = (() => {
  const schema = zodToJsonSchema(parameters)
  const properties = schema.properties
  if (!properties || typeof properties !== "object" || !("background" in properties)) return schema
  const nextProperties = { ...properties }
  delete nextProperties.background
  return {
    ...schema,
    properties: nextProperties,
    ...(Array.isArray(schema.required) ? { required: schema.required.filter((field) => field !== "background") } : {}),
  }
})()
// altimate_change end

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    // altimate_change start — upstream_fix: hide disabled background mode from the tool contract.
    jsonSchema: taskJsonSchema,
    // altimate_change end
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      if (params.background === true) {
        throw new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
      }

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const parent = await Session.get(ctx.sessionID)
      // altimate_change start — upstream_fix: inherit parent session denies/external_directory rules for subtasks
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: agent,
      })
      const childToolDenies = [
        {
          permission: "todowrite" as const,
          pattern: "*" as const,
          action: "deny" as const,
        },
        {
          permission: "todoread" as const,
          pattern: "*" as const,
          action: "deny" as const,
        },
        ...(hasTaskPermission
          ? []
          : [
              {
                permission: "task" as const,
                pattern: "*" as const,
                action: "deny" as const,
              },
            ]),
        ...(config.experimental?.primary_tools?.map((permission) => ({
          pattern: "*" as const,
          action: "deny" as const,
          permission,
        })) ?? []),
      ]
      // altimate_change end

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = MessageID.ascending()
      const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined

      function cancel() {
        // altimate_change start — SessionPrompt.cancel became async; fire-and-forget OK in abort handler
        // but log unhandled rejections so silent failures surface
        const cancelled = promptOps ? Effect.runPromise(promptOps.cancel(session.id)) : SessionPrompt.cancel(session.id)
        cancelled.catch((err) => {
          log.warn("cancel failed", { sessionID: session.id, err })
        })
        // altimate_change end
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = promptOps
        ? await Effect.runPromise(promptOps.resolvePromptParts(params.prompt))
        : await SessionPrompt.resolvePromptParts(params.prompt)

      const promptInput: SessionPrompt.PromptInput = {
        messageID,
        sessionID: session.id,
        model: {
          // altimate_change start — re-brand to provider/schema ModelID/ProviderID
          // (identity at runtime); agent.model carries the core ModelV2/ProviderV2 brands.
          modelID: ModelID.make(model.modelID),
          providerID: ProviderID.make(model.providerID),
          // altimate_change end
        },
        agent: agent.name,
        parts: promptParts,
      }
      const result = promptOps
        ? await Effect.runPromise(promptOps.prompt(promptInput))
        : await SessionPrompt.prompt(promptInput)

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
