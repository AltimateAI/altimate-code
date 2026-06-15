import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
// altimate_change start — tool retrieval
import { Retrieval } from "@/tool/retrieval"
// altimate_change end
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, never>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    // altimate_change start — pass maxOutputTokens INTO chat.params hook so plugins
    // (codex, github-copilot, third-party) can override it. Upstream PRs #21220 + #21225
    // moved the codex/copilot exclusion logic into plugin chat.params hooks, but
    // session/llm.ts wasn't updated to plumb maxOutputTokens through the hook —
    // plugin overrides were silently a no-op. Compute the default first, let the hook
    // mutate it, then read back from params.maxOutputTokens (line 208).
    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        maxOutputTokens:
          isCodex || provider.id.includes("github-copilot")
            ? undefined
            : ProviderTransform.maxOutputTokens(input.model),
        options,
      },
    )
    // altimate_change end

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const tools = await resolveTools(input)

    // altimate_change start — ensure tool definitions exist for all tool_use blocks in history
    // The Anthropic API (and proxies like LiteLLM) require every tool_use block in
    // message history to have a matching tool definition. When agents switch (Plan→Builder),
    // MCP tools disconnect, or tools are filtered by permissions, the history may reference
    // tools absent from the current set. Add stub definitions for any missing tools.
    // Fixes: https://github.com/AltimateAI/altimate-code/issues/678
    const referencedTools = toolNamesFromMessages(input.messages)
    for (const name of referencedTools) {
      if (!Object.hasOwn(tools, name)) {
        tools[name] = tool({
          description: `[Historical] Tool no longer available in this session`,
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({
            output: "This tool is no longer available. Please use an alternative approach.",
            title: "",
            metadata: {},
          }),
        })
      }
    }
    // altimate_change end

    // altimate_change start — tool retrieval
    // Expose only the relevant top-k tools this turn (flag-gated). Keeps the
    // always-on core + any in-flight (referenced) tools; no-op for small sets.
    if (Retrieval.enabled()) {
      const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
      const c = lastUser?.content as any
      const query =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ")
            : ""
      const list = Object.entries(tools).map(([name, t]) => ({ name, description: (t as any)?.description }))
      const keep = Retrieval.select(query, list, { keep: referencedTools })
      for (const name of Object.keys(tools)) {
        // Never delete "invalid": it's the AI-SDK fallback tool the runtime relies
        // on for malformed tool calls, not a user-facing tool, so it's exempt from
        // retrieval rather than being listed in Retrieval.CORE.
        if (name !== "invalid" && !keep.has(name)) delete tools[name]
      }
    }
    // altimate_change end

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      // altimate_change start — read maxOutputTokens from params (now plumbed through chat.params hook)
      maxOutputTokens: params.maxOutputTokens,
      // altimate_change end
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                // altimate_change start — upstream_fix: UA brand
                "User-Agent": `altimate-code/${Installation.VERSION}`,
                // altimate_change end
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // altimate_change start — collect tool names from message history to prevent API validation errors
  // Anthropic API requires every tool_use block in message history to have a matching tool
  // definition. When agents switch (e.g. Plan→Builder) or MCP tools disconnect, the history
  // may reference tools no longer in the active set. This function extracts those names so
  // stub definitions can be added. Fixes #678.
  //
  // Tool names must match the API's allowed character set (Anthropic: `[a-zA-Z0-9_-]{1,64}`).
  // If a loaded session file was tampered with, names with shell metacharacters, ANSI escapes,
  // or excessive length are silently dropped rather than registered as stubs.
  const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/
  export function toolNamesFromMessages(messages: ModelMessage[]): Set<string> {
    const names = new Set<string>()
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") {
          if (typeof part.toolName === "string" && VALID_TOOL_NAME_RE.test(part.toolName)) {
            names.add(part.toolName)
          }
        }
      }
    }
    return names
  }
  // altimate_change end
}
