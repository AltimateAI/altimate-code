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
import { ForbiddenError, WorkspaceApi, WorkspaceApiError } from "../../src/altimate/workspace/api-client"
import {
  __resetPinValidation,
  PIN_VALIDATION_TTL_MS,
  readLocalBinding,
  recordApprovedBinding,
  TURN_PIN_WAIT_MS,
  turnBinding,
} from "../../src/altimate/workspace/state"
import { stubEmptySkillList } from "../altimate/workspace/skill-list-fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
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

/** The ranged-file attachment's symbol lookup. Instant unless a test slows it down. */
let symbolLookup: () => Promise<never[]> = async () => []

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
    documentSymbol: () => Effect.promise(() => symbolLookup()),
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
const RELINKED = 9
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
let inheritedPin: Record<string, string | undefined> = {}
// The suite's preload turns the workspace feature off. With it off the turn never reads the pin, so
// these tests turn it on, and the kill-switch test turns it back off.
const originalKillSwitch = process.env.ALTIMATE_DISABLE_WORKSPACE

beforeEach(() => {
  rows = []
  symbolLookup = async () => []
  delete process.env.ALTIMATE_DISABLE_WORKSPACE
  // Cleared, so a pin in the runner's own environment can't decide the unpinned case; restored after.
  inheritedPin = Object.fromEntries(PIN_VARS.map((name) => [name, process.env[name]]))
  for (const name of PIN_VARS) delete process.env[name]
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
  if (originalKillSwitch === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
  else process.env.ALTIMATE_DISABLE_WORKSPACE = originalKillSwitch
  for (const name of PIN_VARS) {
    const value = inheritedPin[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
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

/** The account's workspace list. Returns the number of times it has been asked so far. */
const accountSees = (visible: { id: number; name: string }[]) => {
  const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(async () => visible as never)
  restore.push(() => list.mockRestore())
  return () => list.mock.calls.length
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

/** One turn with attached files (one by default) and a model read, so both ways a turn reaches a tool
 * are covered. The files are missing on purpose: a successful `read` is a file tool and sends no
 * `tool_call` row. A new session unless `session` is given; returns the session it ran in. */
const runTurn = (dir: string, llm: TestLLMServer["Service"], attached = 1, session?: { id: Session.Info["id"] }) =>
  Effect.gen(function* () {
    const file = path.join(dir, "missing.txt")
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    session ??= yield* sessions.create({
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
        ...Array.from({ length: attached }, (_, i) => ({
          type: "file" as const,
          url: pathToFileURL(path.join(dir, `missing-${i}.txt`)).href,
          filename: `missing-${i}.txt`,
          mime: "text/plain",
        })),
      ],
    })
    return session
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
  { timeout: 60_000 },
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
  { timeout: 60_000 },
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
  { timeout: 60_000 },
)

// On `main` the attachment reads name the project's link whatever the pin says; here they take the
// turn's verdict. That the verdict is resolved once however many reads a turn makes is pinned in
// routing-pin.test.ts ("a refused pin is checked once per turn").
it.live("attached files name the turn's verdict on a refused pin, not the project's link", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([{ id: LINKED, name: "project-link" }])
      yield* linkProject(dir)
      pinTo(dir)
      yield* runTurn(dir, llm, 3)

      expect(reads().map((row) => row.workspace_id)).toEqual([undefined, undefined, undefined, undefined])
      expect(rows.filter((row) => row.workspace_id === LINKED)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

/** A prompt in a new pinned session with only `parts`, and its exit: no model call is queued. */
const promptOnly = (parts: SessionPrompt.PromptInput["parts"], noReply?: boolean) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "pinned session",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    return yield* Effect.exit(prompt.prompt({ sessionID: session.id, agent: "build", noReply, parts }))
  })

it.live("a directory attachment's read names the turn's workspace, as a file's does", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir }) {
      accountSees([{ id: PINNED, name: "pinned-workspace" }])
      yield* linkProject(dir)
      pinTo(dir)
      // A missing directory: a failed read is the one that sends a `tool_call` row. The prompt fails
      // with it, before the loop.
      yield* promptOnly([
        { type: "text", text: "list this" },
        {
          type: "file",
          url: pathToFileURL(path.join(dir, "missing-dir")).href,
          filename: "missing-dir",
          mime: "application/x-directory",
        },
      ])

      expect(reads().map((row) => row.workspace_id)).toEqual([PINNED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a prompt that fails leaves no verdict, even from an attachment read that ends after the failure", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir }) {
      accountSees([{ id: LINKED, name: "project-link" }])
      yield* linkProject(dir)
      // The ranged file's symbol lookup outlasts the missing directory, whose failed read fails the prompt.
      symbolLookup = () => new Promise((done) => setTimeout(() => done([]), 300))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "a session",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const exit = yield* Effect.exit(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [
            { type: "text", text: "read these" },
            {
              type: "file",
              url: pathToFileURL(path.join(dir, "missing-dir")).href,
              filename: "missing-dir",
              mime: "application/x-directory",
            },
            {
              type: "file",
              url: `${pathToFileURL(path.join(dir, "missing.txt")).href}?start=3&end=3`,
              filename: "missing.txt",
              mime: "text/plain",
            },
          ],
        }),
      )
      expect(exit._tag).toBe("Failure")
      // Both attachments' reads have run: the ranged file's row is the last thing its part does.
      yield* pollWithTimeout(
        Effect.sync(() => (reads().length === 2 ? true : undefined)),
        "the ranged file's read never ran",
      )
      yield* Effect.promise(() =>
        recordApprovedBinding(
          dir,
          { datamateId: RELINKED, datamateName: "relinked", linkedAt: Date.now(), repoRemote: null, projectPath: dir } as never,
          { awaitBackfill: true },
        ),
      )

      // A loop started now without a prompt (summarize, resume) resolves its own verdict.
      expect((yield* Effect.promise(() => turnBinding(session.id, dir)))?.datamateId).toBe(RELINKED)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a noReply prompt's attachments in a pinned session name no workspace and send no validation", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir }) {
      const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(
        async () =>
          [
            { id: PINNED, name: "pinned-workspace" },
            { id: LINKED, name: "project-link" },
          ] as never,
      )
      restore.push(() => list.mockRestore())
      yield* linkProject(dir)
      pinTo(dir)
      yield* promptOnly(
        [
          { type: "text", text: "for later" },
          { type: "file", url: pathToFileURL(path.join(dir, "missing-0.txt")).href, filename: "missing-0.txt", mime: "text/plain" },
        ],
        true,
      )

      expect(reads().map((row) => row.workspace_id)).toEqual([undefined])
      // Memory sync's own question (is memory on?) passes no credential; the pin's validation does.
      expect(list.mock.calls.filter(([actAs]) => actAs !== undefined).length).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("with the workspace kill switch on, the pin is not checked and the rows name the project's link", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const asked = accountSees([
        { id: PINNED, name: "pinned-workspace" },
        { id: LINKED, name: "project-link" },
      ])
      yield* linkProject(dir)
      pinTo(dir)
      process.env.ALTIMATE_DISABLE_WORKSPACE = "1"
      yield* runTurn(dir, llm)

      expect(asked()).toBe(0)
      expect(named("session_start").map((row) => row.workspace_id)).toEqual([LINKED])
      expect(reads().map((row) => row.workspace_id)).toEqual([LINKED, LINKED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a validation slower than the turn's wait leaves the turn's rows unattributed, with one request", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(async () => {
        await new Promise((done) => setTimeout(done, TURN_PIN_WAIT_MS + 500))
        return [{ id: PINNED, name: "pinned-workspace" }] as never
      })
      restore.push(() => list.mockRestore())
      yield* linkProject(dir)
      pinTo(dir)
      yield* runTurn(dir, llm)

      // Routing and identity join the request the turn started rather than sending their own. The pin's
      // validation acts as a given credential; memory sync's own question (is memory on?) passes none.
      expect(list.mock.calls.filter(([actAs]) => actAs !== undefined).length).toBe(1)
      expect(named("session_start").map((row) => row.workspace_id)).toEqual([undefined])
      expect(reads().map((row) => row.workspace_id)).toEqual([undefined, undefined])
      expect(rows.filter((row) => row.workspace_id === LINKED)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a pin validated earlier keeps naming the turn while the account is unreachable", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      let now = Date.now()
      __resetPinValidation(() => now)
      let reachable = true
      const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(async () => {
        if (!reachable) throw new WorkspaceApiError("Cannot reach the account")
        return [{ id: PINNED, name: "pinned-workspace" }] as never
      })
      restore.push(() => list.mockRestore())
      yield* linkProject(dir)
      pinTo(dir)
      const session = yield* runTurn(dir, llm)
      // Past the validation memo, inside the grace window, and the account no longer answers.
      now += PIN_VALIDATION_TTL_MS + 1
      reachable = false
      rows = []
      yield* runTurn(dir, llm, 1, session)

      expect(named("task_outcome_signal").map((row) => row.workspace_id)).toEqual([PINNED])
      expect(reads().map((row) => row.workspace_id)).toEqual([PINNED, PINNED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a validation refused with a 403 names no workspace, not the project's link", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const list = spyOn(WorkspaceApi, "listDatamates").mockImplementation(async () => {
        throw new ForbiddenError()
      })
      restore.push(() => list.mockRestore())
      yield* linkProject(dir)
      pinTo(dir)
      yield* runTurn(dir, llm)

      expect(named("session_start").map((row) => row.workspace_id)).toEqual([undefined])
      expect(reads().map((row) => row.workspace_id)).toEqual([undefined, undefined])
      expect(rows.filter((row) => row.workspace_id === LINKED)).toEqual([])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
)

it.live("a later turn of the same session names the workspace it resolves, not the first turn's", () =>
  provideTmpdirServerLegacy(
    Effect.fnUntraced(function* ({ dir, llm }) {
      accountSees([{ id: LINKED, name: "project-link" }])
      yield* linkProject(dir)
      const session = yield* runTurn(dir, llm)
      yield* Effect.promise(() =>
        recordApprovedBinding(
          dir,
          { datamateId: RELINKED, datamateName: "relinked", linkedAt: Date.now(), repoRemote: null, projectPath: dir } as never,
          { awaitBackfill: true },
        ),
      )
      expect((yield* Effect.promise(() => readLocalBinding(dir)))?.datamateId).toBe(RELINKED)
      yield* runTurn(dir, llm, 1, session)

      expect(named("task_outcome_signal").map((row) => row.workspace_id)).toEqual([LINKED, RELINKED])
      expect(reads().map((row) => row.workspace_id)).toEqual([LINKED, LINKED, RELINKED, RELINKED])
    }),
    { git: true, config: providerCfg },
  ),
  { timeout: 60_000 },
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
  { timeout: 60_000 },
)
