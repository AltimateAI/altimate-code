import { describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  ForkSessionResponse,
  LoadSessionResponse,
  NewSessionResponse,
  SessionNotification,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
// altimate_change start — fork Provider.Info/Model ids are branded ProviderID/ModelID (src/provider/schema.ts),
// distinct from core ProviderV2.ID/ModelV2.ID used by the ACP session layer; re-brand at the Provider.Info literal.
import { ProviderID, ModelID } from "@/provider/schema"
// altimate_change end
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import * as ACPError from "@/acp/error"
import { UsageService } from "@/acp/usage"
import type { Provider } from "@/provider/provider"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const configuredModelID = ModelV2.ID.make("configured-model")
const secondModelID = ModelV2.ID.make("second-model")

const provider: Provider.Info = {
  id: ProviderID.make(providerID),
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    [modelID]: {
      id: ModelID.make(modelID),
      providerID: ProviderID.make(providerID),
      api: {
        id: modelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Test Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        default: {},
        high: { reasoningEffort: "high" },
      },
    },
    [configuredModelID]: {
      id: ModelID.make(configuredModelID),
      providerID: ProviderID.make(providerID),
      api: {
        id: configuredModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Configured Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
    [secondModelID]: {
      id: ModelID.make(secondModelID),
      providerID: ProviderID.make(providerID),
      api: {
        id: secondModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Second Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
      },
    },
  },
}

describe("ACP service sessions", () => {
  const makeService = (
    messages: readonly { info: unknown; parts: readonly unknown[] }[] = [],
    options?: {
      abort?: (input: { sessionID: string }) => Promise<{ data: boolean }>
      providers?: Provider.Info[]
      providerConfig?: Record<string, unknown>
      configModel?: string
      configFails?: boolean
    },
  ) => {
    const updates: SessionNotification[] = []
    const mcpAdds: string[] = []
    const aborts: string[] = []
    const forks: string[] = []
    const prompts: unknown[] = []
    const commands: unknown[] = []
    const summarizes: unknown[] = []
    const usageUpdates: string[] = []
    const creates: unknown[] = []
    const sessions = Array.from({ length: 102 }, (_, index) => ({
      id: `ses_${index + 1}`,
      directory: index % 2 === 0 ? "/workspace" : "/other",
      title: `Session ${index + 1}`,
      time: { created: index + 1, updated: index + 1 },
    }))
    const sdk = {
      config: {
        providers: () =>
          Promise.resolve({
            data: {
              providers: options?.providers ?? [provider],
            },
          }),
        get: () =>
          options?.configFails
            ? Promise.reject(new Error("config unavailable"))
            : Promise.resolve({ data: { provider: options?.providerConfig, model: options?.configModel } }),
      },
      app: {
        agents: () =>
          Promise.resolve({
            data: [
              { name: "build", mode: "primary", permission: [], options: {} },
              { name: "plan", mode: "primary", description: "Plan first", permission: [], options: {} },
              { name: "hidden", mode: "primary", hidden: true, permission: [], options: {} },
            ],
          }),
        skills: () =>
          Promise.resolve({
            data: [{ name: "review-skill", description: "Review", location: "/skills/review", content: "review" }],
          }),
      },
      command: {
        list: () =>
          Promise.resolve({
            data: [{ name: "init", description: "Initialize", source: "command", template: "init", hints: [] }],
          }),
      },
      session: {
        create: (input: unknown) => {
          creates.push(input)
          return Promise.resolve({ data: { id: "ses_new" } })
        },
        get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
        list: (input: { directory?: string }) =>
          Promise.resolve({
            data: input.directory ? sessions.filter((session) => session.directory === input.directory) : sessions,
          }),
        messages: () => Promise.resolve({ data: messages }),
        prompt: (input: unknown) => {
          prompts.push(input)
          return Promise.resolve({
            data: {
              info: assistantInfo({
                input: 100,
                output: 40,
                reasoning: 7,
                cache: { read: 11, write: 13 },
              }),
            },
          })
        },
        command: (input: unknown) => {
          commands.push(input)
          return Promise.resolve({
            data: {
              info: assistantInfo({
                input: 3,
                output: 4,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              }),
            },
          })
        },
        summarize: (input: unknown) => {
          summarizes.push(input)
          return Promise.resolve({ data: true })
        },
        abort:
          options?.abort ??
          ((input: { sessionID: string }) => {
            aborts.push(input.sessionID)
            return Promise.resolve({ data: true })
          }),
        fork: (input: { sessionID: string }) => {
          forks.push(input.sessionID)
          return Promise.resolve({ data: { id: `fork_${input.sessionID}` } })
        },
      },
      mcp: {
        add: (input: { name?: string }) => {
          if (input.name) mcpAdds.push(input.name)
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OpencodeClient
    const connection = {
      sessionUpdate: (update: SessionNotification) => {
        updates.push(update)
        return Promise.resolve()
      },
    } as Pick<AgentSideConnection, "sessionUpdate">
    const usage = UsageService.Service.of({
      buildUsage: UsageService.buildUsage,
      latestAssistantMessage: UsageService.latestAssistantMessage,
      totalSessionCost: UsageService.totalSessionCost,
      contextLimit: () => Effect.succeed(128000),
      sendUpdate: (input) =>
        Effect.sync(() => {
          usageUpdates.push(input.sessionID)
        }),
    })

    return {
      service: ACPService.make({ sdk, connection, usage }),
      updates,
      mcpAdds,
      aborts,
      forks,
      prompts,
      commands,
      summarizes,
      usageUpdates,
      creates,
    }
  }

  it("creates a backed session with config options and command update", async () => {
    const { service, updates, mcpAdds } = makeService()
    const result = await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [
          { name: "tools", command: "node", args: ["server.js"], env: [] },
          { name: "tools", command: "node", args: ["server.js"], env: [] },
        ],
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(result.sessionId).toBe("ses_new")
    expect(categories(result)).toContain("model")
    expect(categories(result)).toContain("thought_level")
    expect(categories(result)).toContain("mode")
    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates[0])).toContain("available_commands_update")
    expect(JSON.stringify(updates[0])).toContain("review-skill")
    expect(mcpAdds).toEqual(["tools"])
  })

  it("fails before creating a session when Big Pickle is the only implicit option", async () => {
    const bigPickleProvider = {
      ...provider,
      id: ProviderID.make("opencode"),
      name: "OpenCode",
      models: {
        [ModelID.make("big-pickle")]: {
          ...provider.models[modelID],
          id: ModelID.make("big-pickle"),
          providerID: ProviderID.make("opencode"),
          name: "Big Pickle",
        },
      },
    } satisfies Provider.Info
    const { service, creates } = makeService([], { providers: [bigPickleProvider] })

    const failure = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: "ACPServiceFailureError",
      safeMessage: "No supported model is configured. Register Altimate Base or configure another provider.",
      service: "model",
    })
    expect(creates).toHaveLength(0)
  })

  it("fails before creating a session when the configured model is unavailable", async () => {
    const bigPickleProvider = {
      ...provider,
      id: ProviderID.make("opencode"),
      name: "OpenCode",
      models: {
        [ModelID.make("big-pickle")]: {
          ...provider.models[modelID],
          id: ModelID.make("big-pickle"),
          providerID: ProviderID.make("opencode"),
          name: "Big Pickle",
        },
      },
    } satisfies Provider.Info
    const { service, creates } = makeService([], {
      providers: [bigPickleProvider],
      configModel: "opencode/missing",
    })

    const failure = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: "ACPServiceFailureError",
      safeMessage: "No supported model is configured. Register Altimate Base or configure another provider.",
      service: "model",
    })
    expect(creates).toHaveLength(0)
  })

  it("keeps unrelated providers advertised when a provider block names only one of them", async () => {
    // `config.provider` is a customization map — the docs show single-entry blocks setting apiKey
    // or options. Treating it as a catalogue-wide allowlist hid every other authenticated provider
    // from ACP clients and invalidated restored sessions pinned to them.
    const other = {
      ...provider,
      id: ProviderID.make("anthropic"),
      name: "Anthropic",
      models: {
        [ModelID.make("claude-sonnet-4")]: {
          ...provider.models[modelID],
          id: ModelID.make("claude-sonnet-4"),
          providerID: ProviderID.make("anthropic"),
          name: "Claude Sonnet 4",
        },
      },
    } satisfies Provider.Info
    const { service } = makeService([], {
      providers: [provider, other],
      providerConfig: { test: {} },
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const models = flattenSelectOptions(select(result, "model"))

    expect(models.some((option) => option.value.includes("test-model"))).toBe(true)
    expect(models.some((option) => option.value.includes("claude-sonnet-4"))).toBe(true)
  })

  it("does not advertise Altimate Base through an ACP snapshot excluded by a provider allowlist", async () => {
    const baseProvider = {
      ...provider,
      id: ProviderID.make("altimate-free"),
      name: "Altimate",
      models: {
        [ModelID.make("altimate-base")]: {
          ...provider.models[modelID],
          id: ModelID.make("altimate-base"),
          providerID: ProviderID.make("altimate-free"),
          name: "Altimate Base",
        },
      },
    } satisfies Provider.Info
    const { service } = makeService([], {
      providers: [provider, baseProvider],
      providerConfig: { test: {} },
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const models = flattenSelectOptions(select(result, "model"))

    expect(models.some((option) => option.value.includes("altimate-base"))).toBe(false)
    expect(models.some((option) => option.value.includes("test-model"))).toBe(true)
  })

  it("cannot enable Altimate Base merely by naming it in an ACP provider allowlist", async () => {
    const baseProvider = {
      ...provider,
      id: ProviderID.make("altimate-free"),
      name: "Altimate",
      models: {
        [ModelID.make("altimate-base")]: {
          ...provider.models[modelID],
          id: ModelID.make("altimate-base"),
          providerID: ProviderID.make("altimate-free"),
          name: "Altimate Base",
        },
      },
    } satisfies Provider.Info
    const { service } = makeService([], {
      providers: [provider, baseProvider],
      providerConfig: { test: {}, "altimate-free": {} },
    })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const models = flattenSelectOptions(select(result, "model"))

    expect(models.some((option) => option.value.includes("altimate-base"))).toBe(false)
    expect(models.some((option) => option.value.includes("test-model"))).toBe(true)
  })

  it("fails closed for Altimate Base when the project config lookup fails", async () => {
    const baseProvider = {
      ...provider,
      id: ProviderID.make("altimate-free"),
      name: "Altimate",
      models: {
        [ModelID.make("altimate-base")]: {
          ...provider.models[modelID],
          id: ModelID.make("altimate-base"),
          providerID: ProviderID.make("altimate-free"),
          name: "Altimate Base",
        },
      },
    } satisfies Provider.Info
    const { service, creates } = makeService([], {
      providers: [baseProvider],
      configFails: true,
    })

    const failure = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: "ACPServiceFailureError",
      safeMessage: "No supported model is configured. Register Altimate Base or configure another provider.",
      service: "model",
    })
    expect(creates).toHaveLength(0)
  })

  it("fails before forking when no supported implicit model exists", async () => {
    const bigPickleProvider = {
      ...provider,
      id: ProviderID.make("opencode"),
      name: "OpenCode",
      models: {
        [ModelID.make("big-pickle")]: {
          ...provider.models[modelID],
          id: ModelID.make("big-pickle"),
          providerID: ProviderID.make("opencode"),
          name: "Big Pickle",
        },
      },
    } satisfies Provider.Info
    const { service, forks } = makeService([], { providers: [bigPickleProvider] })

    const failure = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] }).pipe(Effect.flip),
    )

    expect(failure).toMatchObject({ service: "model" })
    expect(forks).toHaveLength(0)
  })

  it("forks with the current default when the source model is no longer advertised", async () => {
    const { service, forks } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "removed-provider",
          modelID: "removed-model",
        },
        parts: [],
      },
    ])

    const result = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/test-model")
    expect(forks).toHaveLength(1)
  })

  it("drops a restored variant when load, resume, or fork falls back to a different model", async () => {
    // `high` is valid for the fallback model, which makes this the important
    // case: it still belongs to the removed model and must not leak across the
    // model boundary merely because the variant names happen to match.
    const { service } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "removed-provider",
          modelID: "removed-model",
          variant: "high",
        },
        parts: [],
      },
    ])

    const loaded = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_fallback_load", mcpServers: [] }),
    )
    const resumed = await Effect.runPromise(
      service.resumeSession({ cwd: "/workspace", sessionId: "ses_fallback_resume", mcpServers: [] }),
    )
    const forked = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_fallback_parent", mcpServers: [] }),
    )

    for (const result of [loaded, resumed, forked]) {
      expect(select(result, "model")?.currentValue).toBe("test/test-model")
      expect(select(result, "effort")?.currentValue).toBe("default")
    }
  })

  it("loads a session and restores model variant and mode from messages", async () => {
    const { service } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          variant: "high",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("drops a restored variant that is no longer advertised by the retained model", async () => {
    const { service } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          variant: "retired-effort",
        },
        parts: [],
      },
    ])

    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_invalid_variant", mcpServers: [] }),
    )

    expect(select(result, "effort")?.currentValue).toBe("default")
  })

  it("replays loaded session transcript chunks", async () => {
    const { service, updates } = makeService([
      {
        info: { id: "msg_user", sessionID: "ses_loaded", role: "user" },
        parts: [{ id: "part_user", sessionID: "ses_loaded", messageID: "msg_user", type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_loaded", role: "assistant" },
        parts: [
          {
            id: "part_assistant",
            sessionID: "ses_loaded",
            messageID: "msg_assistant",
            type: "text",
            text: "hi there",
          },
        ],
      },
    ])

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(
      updates
        .map((item) => item.update)
        .filter((item) => item.sessionUpdate === "user_message_chunk" || item.sessionUpdate === "agent_message_chunk"),
    ).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "msg_user",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_assistant",
        content: { type: "text", text: "hi there" },
      },
    ])
  })

  it("lists sessions sorted by updated time with cursor support", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))
    const second = await Effect.runPromise(service.listSessions({ cwd: "/workspace", cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(51)
    expect(first.sessions[0]?.sessionId).toBe("ses_101")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_1")
    expect(first.nextCursor).toBeUndefined()
    expect(second.sessions).toEqual(first.sessions)
  })

  it("includes live ACP sessions before they appear in server-backed session list", async () => {
    const { service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const listed = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))

    expect(listed.sessions[0]?.sessionId).toBe(created.sessionId)
    expect(listed.sessions[0]?.cwd).toBe("/workspace")
  })

  it("lists all sessions with next cursor when the first page is full", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({}))
    const second = await Effect.runPromise(service.listSessions({ cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(100)
    expect(first.sessions[0]?.sessionId).toBe("ses_102")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_3")
    expect(first.nextCursor).toBe("3")
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["ses_2", "ses_1"])
  })

  it("resumes a session and stores restored state", async () => {
    const { service } = makeService([
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [],
      },
    ])
    const resumed = await Effect.runPromise(
      service.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: "ses_resume", configId: "effort", value: "default" }),
    )

    expect(select(resumed, "effort")?.currentValue).toBe("high")
    expect(select(updated, "effort")?.currentValue).toBe("default")
  })

  it("closes local ACP state and aborts the backing session best-effort", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    const missing = await Effect.runPromise(
      service
        .setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )
    expect(missing.code).toBe(-32602)
    expect(aborts).toEqual([created.sessionId])
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("cancel aborts the backing session and keeps the ACP session", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))

    // The running turn was aborted via the core session API.
    expect(aborts).toEqual([created.sessionId])
    // Unlike closeSession, the ACP session is still present afterwards so
    // the client can keep prompting.
    const stillUsable = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" }),
    )
    expect(stillUsable).toBeDefined()
  })

  it("does not fail cancel or close when the backing abort fails", async () => {
    const { service } = makeService([], { abort: () => Promise.reject(new Error("nope")) })
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))
    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("forks a session, loads fork state, and returns config options", async () => {
    const { service, forks } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "second-model",
          variant: "medium",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const forked = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: forked.sessionId, configId: "effort", value: "low" }),
    )

    expect(forked.sessionId).toBe("fork_ses_parent")
    expect(select(forked, "model")?.currentValue).toBe("test/second-model")
    expect(select(forked, "effort")?.currentValue).toBe("medium")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(forks).toEqual(["ses_parent"])
  })

  it("restores model variant and mode from the latest user message", async () => {
    const { service } = makeService([
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "default" },
          agent: "build",
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("maps provider auth failures to auth-required request errors", async () => {
    const service = ACPService.make({
      sdk: {
        config: {
          providers: () => Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } }),
          get: () => Promise.resolve({ data: {} }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        command: {
          list: () => Promise.resolve({ data: [] }),
        },
      } as unknown as OpencodeClient,
    })
    const error = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32000)
  })

  it("does not cache failed directory snapshots", async () => {
    let providersCalls = 0
    const sdk = {
      config: {
        providers: () => {
          providersCalls++
          if (providersCalls === 1) {
            return Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } })
          }
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_retry" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })

    const first = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )
    const second = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(first.code).toBe(-32000)
    expect(second.sessionId).toBe("ses_retry")
    expect(providersCalls).toBe(2)
  })

  it("registers same-name MCP servers again for different sessions or configs", async () => {
    const adds: unknown[] = []
    let nextSession = 0
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: () => {
          nextSession++
          return Promise.resolve({ data: { id: `ses_${nextSession}` } })
        },
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: (input: unknown) => {
          adds.push(input)
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })

    await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [{ name: "tools", command: "node", args: ["one.js"], env: [] }],
      }),
    )
    await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [{ name: "tools", command: "node", args: ["two.js"], env: [] }],
      }),
    )

    expect(adds).toHaveLength(2)
    expect(JSON.stringify(adds[0])).toContain("one.js")
    expect(JSON.stringify(adds[1])).toContain("two.js")
  })

  it("uses the configured model as the new session default", async () => {
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: { model: "test/configured-model" } }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("configured-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/configured-model")
  })

  it("does not scan last-used sessions when resolving the new session default", async () => {
    const historyCalls: string[] = []
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => {
          historyCalls.push("list")
          return Promise.resolve({ data: [{ id: "ses_recent" }] })
        },
        messages: () => {
          historyCalls.push("messages")
          return Promise.resolve({
            data: [{ info: { role: "user", model: { providerID: "test", modelID: "second-model" } } }],
          })
        },
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("test-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/test-model")
    expect(historyCalls).toEqual([])
  })

  it("switches model and returns updated model and effort options", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(flattenSelectOptions(select(updated, "effort")).map((option) => option.value)).toEqual(["low", "medium"])
  })

  it("switches effort and returns the updated effort current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(select(updated, "effort")?.currentValue).toBe("high")
  })

  it("switches mode and returns the updated mode current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    expect(select(updated, "mode")?.currentValue).toBe("plan")
  })

  it("maps invalid model effort mode and config id to invalid params", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const results = await Promise.all(
      [
        { configId: "model", value: "test/missing-model" },
        { configId: "effort", value: "max" },
        { configId: "mode", value: "missing-mode" },
        { configId: "missing", value: "value" },
      ].map((input) =>
        Effect.runPromise(
          service
            .setSessionConfigOption({ sessionId: session.sessionId, ...input })
            .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
        ),
      ),
    )
    expect(results.map((error) => error.code)).toEqual([-32602, -32602, -32602, -32602])
  })

  it("does not refetch providers modes or commands when switching effort from session snapshot", async () => {
    const calls = {
      providers: 0,
      agents: 0,
      commands: 0,
      skills: 0,
      mcpAdds: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => {
          calls.mcpAdds++
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1, mcpAdds: 0 })

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1, mcpAdds: 0 })
  })

  it("switches model against the warm provider snapshot without refetching", async () => {
    const calls = {
      providers: 0,
      agents: 0,
      commands: 0,
      skills: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_model_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1 })
  })

  it("reuses the warm directory snapshot for a second new session in the same cwd", async () => {
    const calls = {
      providers: 0,
      config: 0,
      agents: 0,
      commands: 0,
      skills: 0,
      sessionList: 0,
      messages: 0,
      creates: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => {
          calls.config++
          return Promise.resolve({ data: {} })
        },
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => {
          calls.creates++
          return Promise.resolve({ data: { id: `ses_warm_${calls.creates}` } })
        },
        list: () => {
          calls.sessionList++
          return Promise.resolve({ data: [] })
        },
        messages: () => {
          calls.messages++
          return Promise.resolve({ data: [] })
        },
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OpencodeClient
    const service = ACPService.make({ sdk })

    const first = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const second = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(first.sessionId).toBe("ses_warm_1")
    expect(second.sessionId).toBe("ses_warm_2")
    expect(calls).toEqual({
      providers: 1,
      config: 1,
      agents: 1,
      commands: 1,
      skills: 1,
      sessionList: 0,
      messages: 0,
      creates: 2,
    })
  })

  it("normal text prompt sends model variant mode and converted parts", async () => {
    const { service, prompts, usageUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    const result = await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        messageId: "00000000-0000-4000-8000-000000000001",
        prompt: [{ type: "text", text: "hello" }],
      }),
    )

    expect(prompts).toEqual([
      {
        sessionID: session.sessionId,
        model: { providerID, modelID },
        variant: "high",
        parts: [{ type: "text", text: "hello" }],
        agent: "plan",
        directory: "/workspace",
      },
    ])
    expect(result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        thoughtTokens: 7,
        cachedReadTokens: 11,
        cachedWriteTokens: 13,
        totalTokens: 171,
      },
      userMessageId: "00000000-0000-4000-8000-000000000001",
      _meta: {},
    })
    expect(usageUpdates).toEqual([session.sessionId])
  })

  it("prompt maps assistant and user audience annotations", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "assistant context", annotations: { audience: ["assistant"] } },
          { type: "text", text: "user context", annotations: { audience: ["user"] } },
        ],
      }),
    )

    expect(prompts).toContainEqual({
      sessionID: session.sessionId,
      model: { providerID, modelID },
      variant: "default",
      parts: [
        { type: "text", text: "assistant context", synthetic: true },
        { type: "text", text: "user context", ignored: true },
      ],
      agent: "build",
      directory: "/workspace",
    })
  })

  it("prompt sends image and resource parts", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///tmp/screenshot.png" },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/report.pdf",
              mimeType: "application/pdf",
              blob: "JVBERg==",
            },
          },
        ],
      }),
    )

    expect((prompts[0] as { parts?: unknown }).parts).toEqual([
      {
        type: "file",
        url: "data:image/png;base64,AAAA",
        filename: "screenshot.png",
        mime: "image/png",
      },
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERg==",
        filename: "report.pdf",
        mime: "application/pdf",
      },
    ])
  })

  it("slash command prompt calls session command", async () => {
    const { service, prompts, commands } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const result = await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/init now" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([
      {
        sessionID: session.sessionId,
        command: "init",
        arguments: "now",
        model: "test/test-model",
        variant: "default",
        agent: "build",
        directory: "/workspace",
      },
    ])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  })

  it("compact slash command calls summarize path", async () => {
    const { service, prompts, commands, summarizes } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/compact" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([])
    expect(summarizes).toEqual([
      {
        sessionID: session.sessionId,
        directory: "/workspace",
        providerID,
        modelID,
      },
    ])
  })

  it("maps prompt auth failures to auth-required request errors", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const failing = ACPService.make({
      sdk: {
        config: {
          providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
          get: () => Promise.resolve({ data: {} }),
        },
        app: {
          agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        command: {
          list: () => Promise.resolve({ data: [] }),
        },
        session: {
          create: () => Promise.resolve({ data: { id: session.sessionId } }),
          list: () => Promise.resolve({ data: [] }),
          prompt: () => Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } }),
        },
        mcp: {
          add: () => Promise.resolve({ data: {} }),
        },
      } as unknown as OpencodeClient,
      usage: UsageService.Service.of({
        buildUsage: UsageService.buildUsage,
        latestAssistantMessage: UsageService.latestAssistantMessage,
        totalSessionCost: UsageService.totalSessionCost,
        contextLimit: () => Effect.succeed(128000),
        sendUpdate: () => Effect.void,
      }),
    })
    await Effect.runPromise(failing.newSession({ cwd: "/workspace", mcpServers: [] }))
    const error = await Effect.runPromise(
      failing
        .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32000)
  })
})

function assistantInfo(tokens: UsageService.AssistantTokenCost["tokens"]): UsageService.AssistantMessage {
  return {
    role: "assistant",
    providerID: "test",
    modelID: "test-model",
    cost: 0,
    tokens,
  }
}

function categories(result: NewSessionResponse | LoadSessionResponse) {
  return result.configOptions?.map((option) => option.category) ?? []
}

function select(
  result: SetSessionConfigOptionResponse | ResumeSessionResponse | NewSessionResponse | ForkSessionResponse,
  id: string,
) {
  return result.configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.id === id && option.type === "select",
  )
}

function flattenSelectOptions(option: Extract<SessionConfigOption, { type: "select" }> | undefined) {
  return option?.options.flatMap((item): SessionConfigSelectOption[] => ("value" in item ? [item] : item.options)) ?? []
}
