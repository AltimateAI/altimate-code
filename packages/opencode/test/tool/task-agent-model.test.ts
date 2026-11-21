import { expect, spyOn } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Bus } from "../../src/bus"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { initTool } from "../altimate/tool-fixture"
import { it } from "../lib/effect"

it.effect("an unavailable subagent model names that agent's config as its source", () =>
  Effect.gen(function* () {
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
    const published: unknown[][] = []
    const mocks = [
      spyOn(Agent, "list").mockResolvedValue([agent]),
      spyOn(Agent, "get").mockResolvedValue(agent),
      spyOn(Config, "get").mockResolvedValue({}),
      spyOn(Session, "get").mockImplementation(
        Object.assign(
          async (id: SessionID) =>
            ({
              id,
              permission: [],
              ...(id === childID ? { parentID, metadata: { taskAgent: "explore" } } : {}),
            }) as never,
          Session.get,
        ),
      ),
      spyOn(Provider, "getModel").mockImplementation((async (providerID: string, modelID: string) => {
        throw new Provider.ModelNotFoundError({
          providerID: ProviderID.make(providerID),
          modelID: ModelID.make(modelID),
        })
      }) as never),
      spyOn(Bus, "publish").mockImplementation((async (...args: unknown[]) => {
        published.push(args)
      }) as never),
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
      // The child prompt rejects the agent's model the way createUserMessage does, labelled as its request.
      prompt: () =>
        Effect.suspend(() => {
          prompted = true
          return Effect.fail(
            new Provider.ModelNotFoundError({
              providerID: ProviderID.make("missing-provider"),
              modelID: ModelID.make("missing-model"),
              source: "session request (model)",
            }),
          )
        }) as never,
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => mocks.forEach((mock) => mock.mockRestore())))
    const tool = yield* Effect.promise(() => initTool(TaskTool))
    const error = yield* Effect.promise(() =>
      tool
        .execute(
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
        .then(
          () => undefined,
          (failure: unknown) => failure,
        ),
    )
    expect(String(error)).toContain(
      'Model not found: missing-provider/missing-model (from agent "explore" config (model))',
    )
    // As upstream does for a failed subtask, the child session exists; its prompt never runs, so no
    // event labels the model as a session request, and the event published names the agent config.
    expect(created).toBe(true)
    expect(prompted).toBe(false)
    expect(JSON.stringify(published)).toContain('from agent \\"explore\\" config (model)')
    expect(JSON.stringify(published)).not.toContain("session request")
  }),
)
