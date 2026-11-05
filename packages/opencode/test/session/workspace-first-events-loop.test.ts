// altimate_change - new file
/**
 * `first_prompt_sent` and `first_job_completed` through the real prompt loop: once per workspace per
 * machine, from any session bound to it, whether or not the session is an onboarding one.
 */
import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Telemetry } from "../../src/altimate/telemetry"
import * as OnboardingTelemetry from "../../src/altimate/telemetry/onboarding"
import { AltimateApi } from "../../src/altimate/api/client"
import { readLocalBinding, recordApprovedBinding } from "../../src/altimate/workspace/state"
import * as WorkspaceFirstEvents from "../../src/altimate/workspace/first-events"
import { stubEmptySkillList } from "../altimate/workspace/skill-list-fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { provideTmpdirServerLegacy } from "./legacy-instance"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    remove: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    entry: () => Effect.succeed(undefined),
    listMeta: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "test/test-model",
})

const LINKED = 7

type Row = { type: string; workspace_id?: number; job?: string; status?: string; signal?: string }
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

let rows: Row[] = []
let restore: (() => void)[] = []
let stateHome = ""
const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME

beforeEach(() => {
  rows = []
  stateHome = mkdtempSync(path.join(os.tmpdir(), "first-events-loop-state-"))
  process.env.OPENCODE_TEST_STATE_HOME = stateHome
  WorkspaceFirstEvents.resetForTest()
  OnboardingTelemetry.resetForTest()
  const track = spyOn(Telemetry, "track").mockImplementation((event) => void rows.push(event as unknown as Row))
  const enabled = spyOn(Telemetry, "isEnabled").mockImplementation(() => true)
  const creds = spyOn(AltimateApi, "getCredentials").mockImplementation(
    async () => ({ altimateInstanceName: "acme", altimateUrl: "https://api.test", altimateApiKey: "k" }) as Creds,
  )
  const configured = spyOn(AltimateApi, "isConfigured").mockImplementation(async () => true)
  restore = [
    () => track.mockRestore(),
    () => enabled.mockRestore(),
    () => creds.mockRestore(),
    () => configured.mockRestore(),
    stubEmptySkillList("api.test"),
  ]
})

afterEach(() => {
  for (const undo of restore) undo()
  OnboardingTelemetry.resetForTest()
  if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
  else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  rmSync(stateHome, { recursive: true, force: true })
})

const linkProject = (dir: string) =>
  Effect.promise(async () => {
    await recordApprovedBinding(
      dir,
      { datamateId: LINKED, datamateName: "project-link", linkedAt: Date.now(), repoRemote: null, projectPath: dir } as never,
      { awaitBackfill: true },
    )
    expect((await readLocalBinding(dir))?.datamateId).toBe(LINKED)
  })

/**
 * One typed turn in a new session. `tool` queues a model tool call first, so the turn did some work;
 * `failedTool` queues one that fails, a read of a missing file.
 */
const turn = (
  dir: string,
  llm: TestLLMServer["Service"],
  opts: { tool?: boolean; failedTool?: boolean; before?: (id: string) => void } = {},
) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "a session",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    if (opts.failedTool) yield* llm.tool("read", { filePath: path.join(dir, "missing.txt") })
    if (opts.tool) {
      const file = path.join(dir, "note.txt")
      yield* Effect.promise(() => Bun.write(file, "note"))
      yield* llm.tool("read", { filePath: file })
    }
    yield* llm.text("done")
    opts.before?.(session.id)
    yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do the thing" }] })
  })

const named = (type: string) => rows.filter((row) => row.type === type)
const firstPrompts = () => named("first_prompt_sent").map((row) => row.workspace_id)
const firstJobs = () => named("first_job_completed").map((row) => [row.workspace_id, row.job])

it.live("a bound session sends both rows, naming the workspace", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm, { tool: true })

      expect(firstPrompts()).toEqual([LINKED])
      expect(firstJobs()).toEqual([[LINKED, "something_else"]])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("neither row is sent again: not by a later session, nor by a new process", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm, { tool: true })
      yield* turn(dir, llm, { tool: true })
      WorkspaceFirstEvents.resetForTest()
      yield* turn(dir, llm, { tool: true })

      expect(firstPrompts()).toEqual([LINKED])
      expect(firstJobs()).toEqual([[LINKED, "something_else"]])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 40_000 },
)

it.live("a turn with no tool call is a first prompt but not a job, and the job can come later", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm)
      expect(firstPrompts()).toEqual([LINKED])
      expect(firstJobs()).toEqual([])

      yield* turn(dir, llm, { tool: true })
      expect(firstPrompts()).toEqual([LINKED])
      expect(firstJobs()).toEqual([[LINKED, "something_else"]])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("a completed turn whose only tool call failed is not a job, and a later turn with one that works is", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm, { failedTool: true })
      expect(named("tool_call").map((row) => row.status)).toEqual(["error"])
      expect(named("task_outcome_signal").map((row) => row.signal)).toEqual(["accepted"])
      expect(firstJobs()).toEqual([])

      yield* turn(dir, llm, { failedTool: true, tool: true })
      expect(firstJobs()).toEqual([[LINKED, "something_else"]])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("a slash command is not a first prompt, and the next typed message is", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm, { before: (id) => OnboardingTelemetry.noteCommandSubmission(id) })
      expect(firstPrompts()).toEqual([])

      yield* turn(dir, llm)
      expect(firstPrompts()).toEqual([LINKED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("an unbound session sends neither row", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* turn(dir, llm, { tool: true })

      expect(firstPrompts()).toEqual([])
      expect(firstJobs()).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("an onboarding session in a bound project sends one row, and a later session none", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* linkProject(dir)
      yield* turn(dir, llm, { before: (id) => OnboardingTelemetry.markOnboardingSession(id) })
      yield* turn(dir, llm)

      expect(firstPrompts()).toEqual([LINKED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("an onboarding session in an unbound project still sends its row", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      yield* turn(dir, llm, { before: (id) => OnboardingTelemetry.markOnboardingSession(id) })

      expect(firstPrompts()).toEqual([undefined])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)
