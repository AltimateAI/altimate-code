// altimate_change start — exercise the session resolver's real tool context builder
import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test model",
  capabilities: {
    temperature: true, reasoning: false, attachment: false, toolcall: true, interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active", options: {}, headers: {}, release_date: "2026-01-01",
}
const agent: Agent.Info = {
  name: "build", mode: "primary", options: {},
  permission: Permission.fromConfig({ "*": "allow", read: { "*": "allow", "private/**": "deny" } }),
}
const it = testEffect(Layer.mergeAll(
  Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  Layer.mock(Permission.Service, {}),
  Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service, {}),
  Layer.mock(ToolRegistry.Service, {
    tools: () => Effect.succeed([{
      id: "permission_probe", description: "Report the context passed into this tool",
      parameters: Schema.Struct({}), registrySource: undefined,
      execute: (_args, ctx) => Effect.succeed({
        title: "Permissions", output: JSON.stringify(ctx.permissions), metadata: {},
      }),
    }]),
  }),
))

for (const sessionRules of [undefined, Permission.fromConfig({ read: { "private/released.txt": "allow" } })]) {
  it.live(`session/tools passes ${sessionRules ? "merged agent and session" : "agent-only"} permissions to tool calls`, () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_tools_permissions")
      const messageID = MessageID.make("msg_tools_permissions")
      const tools = yield* SessionTools.resolve({
        agent, model, bypassAgentCheck: false, messages: [],
        session: {
          id: sessionID, slug: "tools-permissions", projectID: ProjectV2.ID.make("project"),
          directory: "/tmp", title: "Permissions", version: "1", time: { created: 0, updated: 0 },
          permission: sessionRules,
        },
        processor: {
          message: {
            id: messageID, sessionID, role: "assistant", time: { created: 0 },
            parentID: MessageID.make("msg_user"), modelID: model.id, providerID: model.providerID,
            mode: "build", agent: "build", path: { cwd: "/tmp", root: "/tmp" }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          updateToolCall: () => Effect.succeed(undefined),
          completeToolCall: () => Effect.void,
        },
        promptOps: {
          resolvePromptParts: () => Effect.succeed([]),
          prompt: () => Effect.die("unexpected prompt"),
          cancel: () => Effect.void,
        },
      })
      const result = yield* Effect.promise(() => Promise.resolve(tools.permission_probe.execute!({}, {
        toolCallId: "call_permissions", messages: [], abortSignal: AbortSignal.any([]),
      })))
      const received: PermissionV1.Ruleset = JSON.parse((result as { output: string }).output)
      expect(received).toEqual(Permission.merge(agent.permission, sessionRules ?? []))
      expect(Permission.evaluate("read", "private/hidden.txt", received).action).toBe("deny")
      expect(Permission.evaluate("read", "private/released.txt", received).action)
        .toBe(sessionRules ? "allow" : "deny")
    }),
  )
}
// altimate_change end
