// altimate_change - new file
/**
 * The workspace a pinned session's rows name, through the real prompt loop. The IDE extension's pin
 * outranks the project's own link everywhere else, so a turn's rows have to name the pin too: the
 * loop's `session_start` and the tool rows of a model call and of an attached file. The project's
 * own link (id 7) differs from the pin (id 42) in every test, so a row that read the wrong source
 * cannot pass by accident.
 */
import { afterEach, beforeEach, expect, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Telemetry } from "../../src/altimate/telemetry"
import { AltimateApi } from "../../src/altimate/api/client"
import { WorkspaceApi } from "../../src/altimate/workspace/api-client"
import { __resetPinValidation, readLocalBinding, recordApprovedBinding } from "../../src/altimate/workspace/state"
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

const PINNED = 42
const LINKED = 7
const PIN_VARS = [
  "ALTIMATE_CODE_SERVE",
  "ALTIMATE_PINNED_WORKSPACE_ID",
  "ALTIMATE_PINNED_WORKSPACE_NAME",
  "ALTIMATE_PINNED_WORKSPACE_ROOT",
]

type Row = { type: string; workspace_id?: number; tool_name?: string }
type Creds = Awaited<ReturnType<typeof AltimateApi.getCredentials>>

let rows: Row[] = []
let restore: (() => void)[] = []
let stateHome = ""
const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME

beforeEach(() => {
  rows = []
  stateHome = mkdtempSync(path.join(os.tmpdir(), "pinned-loop-state-"))
  process.env.OPENCODE_TEST_STATE_HOME = stateHome
  __resetPinValidation()
  const track = spyOn(Telemetry, "track").mockImplementation((event) => void rows.push(event as unknown as Row))
  const creds = spyOn(AltimateApi, "getCredentials").mockImplementation(
    async () => ({ altimateInstanceName: "acme", altimateUrl: "https://api.test", altimateApiKey: "k" }) as Creds,
  )
  const configured = spyOn(AltimateApi, "isConfigured").mockImplementation(async () => true)
  restore = [
    () => track.mockRestore(),
    () => creds.mockRestore(),
    () => configured.mockRestore(),
    stubEmptySkillList("api.test"),
  ]
})

afterEach(() => {
  for (const undo of restore) undo()
  for (const name of PIN_VARS) delete process.env[name]
  __resetPinValidation()
  if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
  else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  rmSync(stateHome, { recursive: true, force: true })
})

/** What the extension sets on the `serve` it spawns. */
const pinTo = (root: string) => {
  process.env.ALTIMATE_CODE_SERVE = "1"
  process.env.ALTIMATE_PINNED_WORKSPACE_ID = String(PINNED)
  process.env.ALTIMATE_PINNED_WORKSPACE_NAME = "pinned-workspace"
  process.env.ALTIMATE_PINNED_WORKSPACE_ROOT = root
}

const accountSees = (visible: { id: number; name: string }[]) => {
  const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(async () => visible as never)
  restore.push(() => list.mockRestore())
}

/** The project's own link, naming a different workspace than the pin. Checked, so a seed that did not
 * land cannot make the "never the project's link" assertions pass on nothing. */
const linkProject = (dir: string) =>
  Effect.promise(async () => {
    await recordApprovedBinding(
      dir,
      { datamateId: LINKED, datamateName: "project-link", linkedAt: Date.now(), repoRemote: null, projectPath: dir } as never,
      { awaitBackfill: true },
    )
    expect((await readLocalBinding(dir))?.datamateId).toBe(LINKED)
  })

/** One turn with an attached file and a model read, so both ways a turn reaches a tool are covered.
 * The file is missing on purpose: a successful `read` is a file tool and sends no `tool_call` row. */
const runTurn = (dir: string, llm: TestLLMServer["Service"]) =>
  Effect.gen(function* () {
    const file = path.join(dir, "missing.txt")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "pinned session",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [
        { type: "text", text: "read this" },
        { type: "file", url: pathToFileURL(file).href, filename: "missing.txt", mime: "text/plain" },
      ],
    })
  })

const named = (type: string) => rows.filter((row) => row.type === type)
const reads = () => named("tool_call").filter((row) => row.tool_name === "read")

it.live("a pinned session with a different on-disk link names the pinned workspace", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([
        { id: PINNED, name: "pinned-workspace" },
        { id: LINKED, name: "project-link" },
      ])
      yield* linkProject(dir)
      pinTo(dir)
      yield* runTurn(dir, llm)

      expect(named("session_start").map((row) => row.workspace_id)).toEqual([PINNED])
      // The attached file's read and the model's read.
      expect(reads().map((row) => row.workspace_id)).toEqual([PINNED, PINNED])
      expect(rows.filter((row) => row.workspace_id === LINKED)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("a pinned session with no on-disk link still names the pinned workspace", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([{ id: PINNED, name: "pinned-workspace" }])
      pinTo(dir)
      yield* runTurn(dir, llm)

      expect(named("session_start").map((row) => row.workspace_id)).toEqual([PINNED])
      expect(reads().map((row) => row.workspace_id)).toEqual([PINNED, PINNED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("a pin this account cannot see names no workspace, not the project's link", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([{ id: LINKED, name: "project-link" }])
      yield* linkProject(dir)
      pinTo(dir)
      yield* runTurn(dir, llm)

      expect(named("session_start").map((row) => row.workspace_id)).toEqual([undefined])
      expect(reads().map((row) => row.workspace_id)).toEqual([undefined, undefined])
      expect(rows.filter((row) => row.workspace_id === LINKED)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)

it.live("an unpinned session keeps naming the project's link", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([{ id: LINKED, name: "project-link" }])
      yield* linkProject(dir)
      yield* runTurn(dir, llm)

      expect(named("session_start").map((row) => row.workspace_id)).toEqual([LINKED])
      expect(reads().map((row) => row.workspace_id)).toEqual([LINKED, LINKED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 30_000 },
)
