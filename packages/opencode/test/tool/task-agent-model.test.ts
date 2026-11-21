import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { initTool } from "../altimate/tool-fixture"

test("an unavailable subagent model names that agent's config as its source", async () => {
  const parentID = SessionID.make("ses_agent_model_parent")
  const childID = SessionID.make("ses_agent_model_child")
  const messageID = MessageID.make("msg_agent_model_parent")
  const agent = {
    name: "explore",
    mode: "subagent",
    permission: [],
    options: {},
    model: { providerID: "missing-provider", modelID: "missing-model" },
  } as unknown as Agent.Info
  let prompted = false
  let created = false
  const mocks = [
    spyOn(Agent, "list").mockResolvedValue([agent]),
    spyOn(Agent, "get").mockResolvedValue(agent),
    spyOn(Config, "get").mockResolvedValue({}),
    spyOn(Provider, "getModel").mockImplementation((async (providerID: string, modelID: string) => {
      throw new Provider.ModelNotFoundError({
        providerID: ProviderID.make(providerID),
        modelID: ModelID.make(modelID),
      })
    }) as never),
    spyOn(Session, "get").mockImplementation(
      Object.assign(
        async (id: SessionID) =>
          ({ id, permission: [], ...(id === childID ? { parentID, metadata: { taskAgent: "explore" } } : {}) }) as never,
        Session.get,
      ),
    ),
    spyOn(Session, "create").mockImplementation((async () => {
      created = true
      return { id: childID, permission: [] }
    }) as never),
    spyOn(MessageV2, "get").mockResolvedValue({
      info: { role: "assistant", parentID: messageID, modelID: "test", providerID: "test" },
      parts: [],
    } as never),
  ]
  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: () =>
      Effect.sync(() => {
        prompted = true
        return { info: { role: "assistant" }, parts: [] } as unknown as MessageV2.WithParts
      }),
  }
  try {
    const tool = await initTool(TaskTool)
    const run = tool.execute(
      { description: "Explore", prompt: "Look around", subagent_type: "explore" },
      {
        sessionID: parentID,
        messageID,
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        extra: { promptOps, bypassAgentCheck: true },
      },
    )
    await expect(run).rejects.toThrow('Model not found: missing-provider/missing-model (from agent "explore" config (model))')
    expect(prompted).toBe(false)
    expect(created).toBe(false)
  } finally {
    for (const mock of mocks) mock.mockRestore()
  }
})
