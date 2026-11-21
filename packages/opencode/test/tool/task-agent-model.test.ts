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
import { TraceContext } from "../../src/altimate/observability/trace-context"
import { it } from "../lib/effect"

const runTask = (input: { background?: boolean; abort: AbortSignal; onLookup?: () => unknown }) =>
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
    let lookedUp = false
    let traced = 0
    let created = false
    const published: unknown[][] = []
    const mocks = [
      spyOn(TraceContext, "inherit").mockImplementation((() => {
        traced++
      }) as never),
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
        lookedUp = true
        if (input.onLookup) return input.onLookup()
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
          { description: "Explore", prompt: "Look around", subagent_type: "explore", background: input.background },
          {
            sessionID: parentID,
            messageID,
            agent: "build",
            abort: input.abort,
            messages: [],
            extra: { promptOps, bypassAgentCheck: true, backgroundSubagents: input.background === true },
          },
        )
        .then(
          () => undefined,
          (failure: unknown) => failure,
        ),
    )
    return { error, created, prompted, lookedUp, published, traced }
  })

it.effect("an unavailable subagent model names that agent's config as its source", () =>
  Effect.gen(function* () {
    const { error, created, prompted, published, traced } = yield* runTask({ abort: new AbortController().signal })
    // A rejected model leaves no trace binding for a child prompt that never runs.
    expect(traced).toBe(0)
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

it.effect("a background subagent with an unavailable model fails before it is reported running", () =>
  Effect.gen(function* () {
    const { error, prompted, published } = yield* runTask({ background: true, abort: new AbortController().signal })
    expect(String(error)).toContain('(from agent "explore" config (model))')
    expect(prompted).toBe(false)
    expect(JSON.stringify(published)).toContain('from agent \\"explore\\" config (model)')
  }),
)

it.effect("a cancelled parent turn reports the cancellation, not the subagent model", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    controller.abort()
    const { error, lookedUp, published } = yield* runTask({ abort: controller.signal })
    expect(error).toBeDefined()
    expect(String(error)).not.toContain("Model not found")
    expect(lookedUp).toBe(false)
    expect(published).toHaveLength(0)
  }),
)

it.effect("cancellation during the model lookup binds no trace and starts no child prompt", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    const { error, prompted, traced } = yield* runTask({
      abort: controller.signal,
      // The lookup succeeds, but the parent turn is cancelled while it runs.
      onLookup: () => {
        controller.abort()
        return {}
      },
    })
    expect(error).toBeDefined()
    expect(String(error)).not.toContain("Model not found")
    expect(prompted).toBe(false)
    expect(traced).toBe(0)
  }),
)

it.effect("an available subagent model binds the child trace once before the child prompt runs", () =>
  Effect.gen(function* () {
    const { prompted, traced } = yield* runTask({ abort: new AbortController().signal, onLookup: () => ({}) })
    expect(traced).toBe(1)
    expect(prompted).toBe(true)
  }),
)
