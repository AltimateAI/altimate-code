import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { ToolLookupTool } from "../../src/altimate/tools/tool-lookup"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { ToolRegistry } from "../../src/tool/registry"
import { initTool } from "../altimate/tool-fixture"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const model = { providerID: ProviderID.opencode, modelID: ModelID.make("test") }
let previousToggle: string | undefined

beforeEach(() => {
  previousToggle = process.env.ALTIMATE_ANSWER_COMMIT
  delete process.env.ALTIMATE_ANSWER_COMMIT
})

afterEach(async () => {
  if (previousToggle === undefined) delete process.env.ALTIMATE_ANSWER_COMMIT
  else process.env.ALTIMATE_ANSWER_COMMIT = previousToggle
  await disposeAllInstances()
})

describe("answer_commit agent scope", () => {
  test("analyst permits and receives answer_commit", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = (await Agent.get("analyst"))!
        expect(Permission.evaluate("answer_commit", "*", analyst.permission).action).toBe("allow")
        const tools = await ToolRegistry.tools(model, analyst)
        expect(tools.filter((tool) => tool.id === "answer_commit")).toHaveLength(1)
      },
    })
  })

  test("a custom agent named analyst receives answer_commit by design", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          analyst: {
            description: "Configured analyst",
            prompt: "Use the configured analyst instructions.",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = (await Agent.get("analyst"))!
        expect(analyst.description).toBe("Configured analyst")
        expect(analyst.prompt).toBe("Use the configured analyst instructions.")
        // Configuration customizes the native analyst; access intentionally follows its name.
        expect(Permission.evaluate("answer_commit", "*", analyst.permission).action).toBe("allow")
        const tools = await ToolRegistry.tools(model, analyst)
        expect(tools.filter((tool) => tool.id === "answer_commit")).toHaveLength(1)
      },
    })
  })

  test("native answer_commit takes precedence over a plugin tool with the same id", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let pluginCalls = 0
        const analyst = (await Agent.get("analyst"))!
        const tools = await ToolRegistry.tools(model, analyst, [
          {
            tool: {
              answer_commit: {
                description: "Plugin answer_commit collision",
                args: {},
                execute: async () => {
                  pluginCalls += 1
                  return "Plugin answer"
                },
              },
            },
          },
        ])
        const candidates = tools.filter((tool) => tool.id === "answer_commit")
        expect(candidates).toHaveLength(2)
        expect(candidates[0].description).toBe("Plugin answer_commit collision")
        expect(candidates[0].registrySource).toBe("external")
        // Both session resolvers assign tools[item.id] in this order, so the last candidate wins.
        const winner = Object.fromEntries(tools.map((tool) => [tool.id, tool])).answer_commit
        expect(winner).toBe(candidates[1])
        expect(winner.registrySource).toBeUndefined()
        const result = await Effect.runPromise(
          winner.execute(
            { fields: [{ name: "Revenue", value: 42 }] },
            {
              sessionID: SessionID.make("ses_answer_commit_collision"),
              messageID: MessageID.make("msg_answer_commit_collision"),
              callID: "call_answer_commit_collision",
              agent: "analyst",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )
        expect(result.title).toBe("Answer committed")
        expect(result.output).toContain("**Answer:** Revenue: 42")
        expect(pluginCalls).toBe(0)
      },
    })
  })

  test("builder, plan, data-explorer and custom agents never receive answer_commit", async () => {
    await using tmp = await tmpdir({
      config: {
        permission: { "*": "allow", answer_commit: "allow" },
        agent: {
          custom: {
            description: "A custom agent",
            mode: "primary",
            permission: { "*": "allow", answer_commit: "allow" },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const name of ["builder", "build", "plan", "data-explorer", "custom"]) {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          const tools = await ToolRegistry.tools(model, agent)
          expect(tools.map((tool) => tool.id)).not.toContain("answer_commit")
        }
        expect((await ToolRegistry.tools(model)).map((tool) => tool.id)).not.toContain("answer_commit")
      },
    })
  })

  test("tool_lookup does not expose answer_commit to builder", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await initTool(ToolLookupTool)
        const ctx = {
          sessionID: SessionID.make("ses_answer_commit"),
          messageID: MessageID.make("msg_answer_commit"),
          callID: "call_answer_commit_lookup",
          agent: "builder",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const missing = await tool.execute({ tool_name: "answer_commit" }, ctx)
        expect(missing.title).toBe("Tool not found")
        const listing = await tool.execute({ tool_name: "__missing_tool" }, ctx)
        expect(listing.output).not.toContain("answer_commit")
        expect((await ToolRegistry.allInfos()).map((info) => info.id)).not.toContain("answer_commit")
        expect(await ToolRegistry.ids()).not.toContain("answer_commit")
      },
    })
  })

  test("ALTIMATE_ANSWER_COMMIT=0 removes the analyst candidate and can be toggled back on", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const analyst = (await Agent.get("analyst"))!
        process.env.ALTIMATE_ANSWER_COMMIT = "0"
        expect((await ToolRegistry.tools(model, analyst)).map((tool) => tool.id)).not.toContain("answer_commit")
        process.env.ALTIMATE_ANSWER_COMMIT = "1"
        expect((await ToolRegistry.tools(model, analyst)).map((tool) => tool.id)).toContain("answer_commit")
      },
    })
  })
})
