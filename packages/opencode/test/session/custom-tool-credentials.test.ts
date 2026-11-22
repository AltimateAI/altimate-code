// altimate_change — synthetic credential collection across custom tool execution and hooks
import { expect, spyOn } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ProjectID } from "@/project/schema"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID, PartID } from "@/session/schema"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import * as Precedence from "@/altimate/workspace/precedence"
import { ToolRegistry } from "@/tool/registry"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: Permission.fromConfig({ "*": "allow" }),
}
const it = testEffect(Layer.empty)
for (const outcome of ["result", "error"] as const)
  it.live(`shipped resolver refreshes custom tool ${outcome} and progress credentials`, () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_prompt_tools_errors")
      const finished: unknown[] = []
      const secret = "synthetic-external-runtime-credential"
      const variable = "ALTIMATE_EXTERNAL_FIXTURE_TOKEN"
      const previous = process.env[variable]
      delete process.env[variable]
      const updates: unknown[] = []
      const update = spyOn(Session, "updatePart").mockImplementation(
        Object.assign(
          async (part: Parameters<typeof Session.updatePart>[0]) => {
            updates.push(part)
            return part
          },
          { force: Session.updatePart.force, schema: Session.updatePart.schema },
        ),
      )
      const registry = spyOn(ToolRegistry, "tools").mockResolvedValue([
        {
          id: "backend_failure",
          description: "Return a backend failure",
          parameters: Schema.Struct({}),
          registrySource: "external",
          execute: (_args, ctx) =>
            Effect.gen(function* () {
              process.env[variable] = secret
              yield* ctx.metadata({ title: secret, metadata: { detail: secret } })
              if (outcome === "error") return yield* Effect.die(new Error(`Fixture failed: ${secret}`))
              return { title: secret, output: secret, metadata: { detail: secret } }
            }),
        },
      ])
      const mcp = spyOn(MCP, "tools").mockResolvedValue({})
      const plugins = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
        if (name === "tool.execute.after") {
          process.env[variable] = "synthetic-hook-runtime-credential"
          if (output && typeof output === "object") Object.assign(output, { output: process.env[variable] })
        }
        return output
      })
      const precedence = spyOn(Precedence, "refresh").mockResolvedValue({
        enabled: false,
        workspaceName: "",
        shadowed: new Map(),
      })
      try {
        const tools = yield* Effect.promise(() =>
          SessionPrompt.resolveTools({
            agent,
            model,
            bypassAgentCheck: false,
            messages: [],
            session: {
              id: sessionID,
              slug: "prompt-tools-errors",
              projectID: ProjectID.make("project"),
              directory: "/tmp",
              title: "Prompt tool errors",
              version: "1",
              time: { created: 0, updated: 0 },
            },
            processor: {
              message: {
                id: MessageID.make("msg_prompt_tools_errors"),
                sessionID,
                role: "assistant",
                time: { created: 0 },
                parentID: MessageID.make("msg_user"),
                modelID: model.id,
                providerID: model.providerID,
                mode: "build",
                agent: "build",
                path: { cwd: "/tmp", root: "/tmp" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              beginToolExecution: (raw) => ({ raw, occurrence: 0 }),
              finishToolExecution: (execution) => {
                finished.push(execution)
              },
              partFromToolExecution: () => ({
                id: PartID.make("prt_fixture"),
                sessionID,
                messageID: MessageID.make("msg_prompt_tools_errors"),
                type: "tool",
                tool: "backend_failure",
                callID: "call_error",
                state: { status: "running", input: {}, time: { start: 0 } },
              }),
              partFromToolCall: () => undefined,
              process: async () => {
                throw new Error("unexpected processor invocation")
              },
            },
          }),
        )
        const result = yield* Effect.promise(async () => {
          try {
            return await tools.backend_failure.execute!(
              {},
              { toolCallId: "call_error", messages: [], abortSignal: new AbortController().signal },
            )
          } catch (error) {
            return String(error)
          }
        })
        expect(JSON.stringify(result)).not.toContain(secret)
        expect(JSON.stringify(result)).not.toContain("synthetic-hook-runtime-credential")
        expect(JSON.stringify(result)).toContain("[REDACTED]")
        expect(JSON.stringify(updates)).not.toContain(secret)
        expect(JSON.stringify(updates)).toContain("[REDACTED]")
        expect(finished).toEqual([{ raw: "call_error", occurrence: 0 }])
      } finally {
        update.mockRestore()
        if (previous === undefined) delete process.env[variable]
        else process.env[variable] = previous
        precedence.mockRestore()
        plugins.mockRestore()
        mcp.mockRestore()
        registry.mockRestore()
      }
    }),
  )
