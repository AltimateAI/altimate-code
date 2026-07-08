import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testProviderConfig } from "../lib/test-provider"

export const SUITE_DIR = import.meta.dir
export const ARTIFACT_DIR = path.join(SUITE_DIR, "artifacts")
export const TEST_MODEL = "test/test-model"

const DEFAULT_WIDTH = 140
const DEFAULT_HEIGHT = 42
const DEFAULT_WAIT_MS = 20_000
let cachedMockServerAvailable: boolean | undefined

export function tmuxAvailable() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" })
  return result.status === 0
}

export function cliPath() {
  const value = process.env.OPENCODE_TEST_CLI
  return value ? path.resolve(value) : undefined
}

export function suiteEnabled() {
  return Boolean(cliPath()) && tmuxAvailable() && mockServerAvailable()
}

export function mockServerAvailable() {
  if (cachedMockServerAvailable !== undefined) return cachedMockServerAvailable
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    })
    server.stop(true)
    cachedMockServerAvailable = true
  } catch {
    cachedMockServerAvailable = false
  }
  return cachedMockServerAvailable
}

export type JourneyContext = {
  readonly llm: MockLLMServer
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly outsideDir: string
  readonly outsideFile: string
  readonly traceDir: string
}

type JourneyOptions = {
  readonly width?: number
  readonly height?: number
  readonly config?: (base: Record<string, unknown>, ctx: JourneyContext) => Record<string, unknown>
  readonly args?: string[]
  readonly env?: Record<string, string>
}

type MockMcpAuthServer = {
  readonly url: string
  readonly close: () => Promise<void>
}

type MockLLMItem = { type: "text"; text: string } | { type: "tool"; name: string; input: unknown }

function tmux(args: string[], opts?: { allowFailure?: boolean }) {
  const result = spawnSync("tmux", args, { encoding: "utf8" })
  if (!opts?.allowFailure && result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${result.status})\n${result.stderr}`)
  }
  return result.stdout
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function safeName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function baseConfig(llmUrl: string, traceDir: string): Record<string, unknown> {
  return {
    ...testProviderConfig(llmUrl),
    model: TEST_MODEL,
    small_model: TEST_MODEL,
    default_agent: "builder",
    autoupdate: false,
    share: "disabled",
    tracing: { enabled: true, dir: traceDir, maxFiles: 0 },
    agent: {
      builder: {
        model: TEST_MODEL,
        mode: "primary",
        permission: { "*": "allow", question: "allow", plan_enter: "allow" },
      },
      reviewer: {
        model: TEST_MODEL,
        mode: "primary",
        hidden: false,
        permission: {
          "*": "deny",
          read: "allow",
          grep: "allow",
          glob: "allow",
          list: "allow",
          webfetch: "allow",
          websearch: "allow",
          tool_lookup: "allow",
          external_directory: "ask",
          bash: "ask",
        },
      },
    },
  }
}

function sseLine(input: unknown) {
  if (input === "[DONE]") return "data: [DONE]\n\n"
  return `data: ${JSON.stringify(input)}\n\n`
}

function chatChunk(input: { delta?: Record<string, unknown>; finish?: string }) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [
      {
        delta: input.delta ?? {},
        ...(input.finish ? { finish_reason: input.finish } : {}),
      },
    ],
  }
}

function responsesCompleted(seq: number) {
  return {
    type: "response.completed",
    sequence_number: seq,
    response: {
      incomplete_details: null,
      service_tier: null,
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: null },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: null },
      },
    },
  }
}

function modelFrom(body: unknown) {
  if (!body || typeof body !== "object") return "test-model"
  if (!("model" in body) || typeof body.model !== "string") return "test-model"
  return body.model
}

function titleRequest(body: unknown) {
  return Boolean(
    body && typeof body === "object" && JSON.stringify(body).includes("Generate a title for this conversation"),
  )
}

function streamResponse(parts: unknown[]) {
  return new Response(parts.map(sseLine).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function chatResponse(item: MockLLMItem) {
  if (item.type === "text") {
    return streamResponse([
      chatChunk({ delta: { role: "assistant" } }),
      chatChunk({ delta: { content: item.text } }),
      chatChunk({ finish: "stop" }),
      "[DONE]",
    ])
  }

  const args = JSON.stringify(item.input)
  return streamResponse([
    chatChunk({ delta: { role: "assistant" } }),
    chatChunk({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: item.name, arguments: "" },
          },
        ],
      },
    }),
    chatChunk({
      delta: {
        tool_calls: [
          {
            index: 0,
            function: { arguments: args },
          },
        ],
      },
    }),
    chatChunk({ finish: "tool_calls" }),
    "[DONE]",
  ])
}

function responsesResponse(item: MockLLMItem, model: string) {
  const created = {
    type: "response.created",
    sequence_number: 1,
    response: {
      id: "resp_test",
      created_at: Math.floor(Date.now() / 1000),
      model,
      service_tier: null,
    },
  }

  if (item.type === "text") {
    return streamResponse([
      created,
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg_1",
        delta: item.text,
        logprobs: null,
      },
      {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 0,
        item: { type: "message", id: "msg_1" },
      },
      responsesCompleted(5),
      "[DONE]",
    ])
  }

  const args = JSON.stringify(item.input)
  return streamResponse([
    created,
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: item.name,
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      output_index: 0,
      item_id: "fc_1",
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 4,
      output_index: 0,
      item_id: "fc_1",
      arguments: args,
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: item.name,
        arguments: args,
        status: "completed",
      },
    },
    responsesCompleted(6),
    "[DONE]",
  ])
}

export class MockLLMServer {
  #server?: ReturnType<typeof Bun.serve>
  #queue: MockLLMItem[] = []
  #hits: Record<string, unknown>[] = []
  url = ""

  static start() {
    const llm = new MockLLMServer()
    llm.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => llm.#handle(req),
    })
    llm.url = `http://127.0.0.1:${llm.#server.port}/v1`
    return llm
  }

  async text(text: string) {
    this.#queue.push({ type: "text", text })
  }

  async tool(name: string, input: unknown) {
    this.#queue.push({ type: "tool", name, input })
  }

  hits() {
    return [...this.#hits]
  }

  stop() {
    this.#server?.stop(true)
    this.#server = undefined
  }

  async #handle(req: Request) {
    const url = new URL(req.url)
    if (req.method !== "POST" || (url.pathname !== "/v1/chat/completions" && url.pathname !== "/v1/responses")) {
      return new Response("not found", { status: 404 })
    }

    const body = await req.json().catch(() => ({}))
    this.#hits.push(body && typeof body === "object" ? (body as Record<string, unknown>) : {})
    const item = titleRequest(body)
      ? { type: "text" as const, text: "E2E Title" }
      : (this.#queue.shift() ?? { type: "text" as const, text: "ok" })

    if (url.pathname === "/v1/responses") return responsesResponse(item, modelFrom(body))
    return chatResponse(item)
  }
}

function isolatedEnv(home: string, configJson: string, extra?: Record<string, string>) {
  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: configJson,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ALTIMATE_CLI_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
    OPENCODE_DISABLE_FFF: "1",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...extra,
  }
}

async function writeLauncher(input: {
  cli: string
  root: string
  workspace: string
  env: Record<string, string>
  args: string[]
}) {
  const launcher = path.join(input.root, "run-tui.sh")
  const stderr = path.join(input.root, "tui.stderr.log")
  const exitLog = path.join(input.root, "tui.exit.log")
  const lines = [
    "#!/bin/sh",
    "set -u",
    ...Object.entries(input.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `cd ${shellQuote(input.workspace)}`,
    `: > ${shellQuote(stderr)}`,
    `: > ${shellQuote(exitLog)}`,
    `${shellQuote(input.cli)} ${input.args.map(shellQuote).join(" ")} "$@" 2>>${shellQuote(stderr)}`,
    "status=$?",
    `printf '%s\\n' "__EXIT=$status" | tee -a ${shellQuote(exitLog)}`,
    "sleep 600",
    'exit "$status"',
    "",
  ]
  await fs.writeFile(launcher, lines.join("\n"), { mode: 0o700 })
  return launcher
}

async function prepareContext(llm: MockLLMServer): Promise<JourneyContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-tui-journey-"))
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const outsideDir = path.join(root, "outside")
  const traceDir = path.join(root, "traces")
  const outsideFile = path.join(outsideDir, "secret.sql")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(outsideDir, { recursive: true })
  await fs.mkdir(traceDir, { recursive: true })
  await fs.writeFile(path.join(workspace, "README.md"), "# TUI journey workspace\n")
  await fs.writeFile(outsideFile, "select 1 as outside_workspace;\n")
  spawnSync("git", ["init"], { cwd: workspace, encoding: "utf8" })
  return { llm, root, home, workspace, outsideDir, outsideFile, traceDir }
}

async function removeRoot(root: string) {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

export async function createMockMcpAuthServer(): Promise<MockMcpAuthServer> {
  let base = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)

      if (
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["repo"],
        })
      }

      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
        url.pathname === "/.well-known/openid-configuration" ||
        url.pathname === "/.well-known/openid-configuration/mcp"
      ) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }

      return Response.json(
        { error: "unauthorized" },
        {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token"`,
          },
        },
      )
    },
  })
  base = `http://127.0.0.1:${server.port}`

  return {
    url: `${base}/mcp`,
    close: async () => server.stop(true),
  }
}

export class TmuxJourney {
  readonly name: string
  readonly session: string
  readonly ctx: JourneyContext
  private readonly options: Required<Pick<JourneyOptions, "width" | "height">> & JourneyOptions
  private started = false

  constructor(name: string, ctx: JourneyContext, options: JourneyOptions = {}) {
    this.name = name
    this.ctx = ctx
    this.options = {
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
      ...options,
    }
    this.session = `oc-tui-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async start() {
    const cli = cliPath()
    if (!cli) throw new Error("OPENCODE_TEST_CLI is not set")
    const config =
      this.options.config?.(baseConfig(this.ctx.llm.url, this.ctx.traceDir), this.ctx) ??
      baseConfig(this.ctx.llm.url, this.ctx.traceDir)
    const env = isolatedEnv(this.ctx.home, JSON.stringify(config), this.options.env)
    const launcher = await writeLauncher({
      cli,
      root: this.ctx.root,
      workspace: this.ctx.workspace,
      env,
      args: ["--model", TEST_MODEL, ...(this.options.args ?? [])],
    })
    tmux([
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      String(this.options.width),
      "-y",
      String(this.options.height),
      "-c",
      this.ctx.workspace,
      launcher,
    ])
    tmux(["set-option", "-w", "-t", this.session, "remain-on-exit", "on"], { allowFailure: true })
    this.started = true
  }

  stop() {
    if (!this.started) return
    tmux(["kill-session", "-t", this.session], { allowFailure: true })
    this.started = false
  }

  send(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys]
    tmux(["send-keys", "-t", this.session, ...list])
  }

  type(text: string) {
    for (let i = 0; i < text.length; i += 500) {
      tmux(["send-keys", "-l", "-t", this.session, "--", text.slice(i, i + 500)])
    }
  }

  snapshot() {
    return tmux(["capture-pane", "-p", "-t", this.session], { allowFailure: true })
  }

  snapshotAnsi() {
    return tmux(["capture-pane", "-e", "-p", "-t", this.session], { allowFailure: true })
  }

  alive() {
    const result = spawnSync("tmux", ["list-panes", "-t", this.session, "-F", "#{pane_dead}"], { encoding: "utf8" })
    return result.status === 0 && !result.stdout.trim().includes("1")
  }

  async waitFor(predicate: (plain: string, ansi: string) => boolean | Promise<boolean>, timeoutMs = DEFAULT_WAIT_MS) {
    const start = Date.now()
    let lastPlain = ""
    let lastAnsi = ""
    let sawDeadPane = false
    while (Date.now() - start < timeoutMs) {
      sawDeadPane ||= !this.alive()
      const plain = this.snapshot()
      const ansi = this.snapshotAnsi()
      if (plain) lastPlain = plain
      if (ansi) lastAnsi = ansi
      if (await predicate(plain || lastPlain, ansi || lastAnsi)) {
        return { plain: plain || lastPlain, ansi: ansi || lastAnsi }
      }
      await Bun.sleep(100)
    }
    throw new Error(`timed out after ${timeoutMs}ms${sawDeadPane ? " (tmux pane exited)" : ""}\n${lastPlain}`)
  }

  async dumpArtifact(reason: unknown) {
    try {
      await fs.mkdir(ARTIFACT_DIR, { recursive: true })
      const base = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(this.name)}`
      const plain = this.started ? this.snapshot() : ""
      const ansi = this.started ? this.snapshotAnsi() : ""
      const stderr = await fs.readFile(path.join(this.ctx.root, "tui.stderr.log"), "utf8").catch(() => "")
      const exit = await fs.readFile(path.join(this.ctx.root, "tui.exit.log"), "utf8").catch(() => "")
      await fs
        .writeFile(
          path.join(ARTIFACT_DIR, `${base}.txt`),
          [
            `# ${this.name}`,
            "",
            "## Error",
            String(reason),
            "",
            "## Launcher Exit",
            exit.trim() || "(no exit recorded)",
            "",
            "## Mock LLM Requests",
            JSON.stringify(this.ctx.llm.hits(), null, 2),
            "",
            "## Stderr",
            stderr || "(empty)",
            "",
            "## Pane",
            plain,
          ].join("\n"),
        )
        .catch(() => {})
      await fs.writeFile(path.join(ARTIFACT_DIR, `${base}.ansi`), ansi).catch(() => {})
      if (stderr) await fs.writeFile(path.join(ARTIFACT_DIR, `${base}.stderr.log`), stderr).catch(() => {})
    } catch {
      // Artifact creation is best-effort and must never mask the journey failure.
    }
  }

  async traceFiles() {
    const entries = await fs.readdir(this.ctx.traceDir).catch(() => [])
    return entries.filter((entry) => entry.endsWith(".json"))
  }
}

export async function withJourney(
  name: string,
  body: (journey: TmuxJourney, ctx: JourneyContext) => Promise<void>,
  options: JourneyOptions = {},
) {
  const llm = MockLLMServer.start()
  const ctx = await prepareContext(llm)
  const journey = new TmuxJourney(name, ctx, options)
  try {
    await journey.start()
    await body(journey, ctx)
  } catch (error) {
    await journey.dumpArtifact(error)
    throw error
  } finally {
    journey.stop()
    llm.stop()
    await removeRoot(ctx.root)
  }
}

export async function booted(journey: TmuxJourney) {
  await journey.waitFor(
    (plain) =>
      /(ctrl\+p commands|altimate code|esc interrupt|test\/test-model|Test Model|┃)/i.test(plain) &&
      !/(Failed to initialize provider|Model not found|Unrecognized key|Invalid config)/i.test(plain),
    25_000,
  )
}

export async function openSlashDialog(journey: TmuxJourney, slash: string, expected: RegExp) {
  journey.type(slash)
  await journey.waitFor((plain) => plain.includes(slash), 5_000)
  journey.send("Enter")
  await journey.waitFor((plain) => expected.test(plain), 20_000)
}

export async function submitPrompt(journey: TmuxJourney, text: string) {
  journey.type(text)
  journey.send("Enter")
}

export async function selectAgent(journey: TmuxJourney, agent: string) {
  for (let i = 0; i < 8; i++) {
    const current = journey.snapshot()
    if (current.toLowerCase().includes(agent.toLowerCase())) return
    journey.send("Tab")
    await Bun.sleep(250)
  }
  await journey.waitFor((plain) => plain.toLowerCase().includes(agent.toLowerCase()), 5_000)
}

export function countVisibleRows(snapshot: string, value: string) {
  return snapshot.split("\n").filter((line) => line.includes(value)).length
}
