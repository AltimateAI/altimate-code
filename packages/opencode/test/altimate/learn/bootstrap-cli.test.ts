// altimate_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import * as Store from "../../../src/altimate/learn/store"
import { DEFAULT_NAME } from "../../../src/altimate/learn/playbook"
import { bootstrapStateFile } from "../../../src/altimate/learn/bootstrap-state"
import { readSignals } from "../../../src/altimate/learn/signals"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")

async function run(cwd: string, args: string[], preload?: string) {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", ...(preload ? ["--preload", preload] : []), entry, "learn", "bootstrap", ...args], {
    cwd,
    env: { ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

/** Replace only stored history and model calls. Parsing, scope, consent, claims and writes stay real. */
async function fixture(cwd: string, confirmation?: boolean) {
  const file = path.join(cwd, "bootstrap-preload.ts")
  const historyModule = JSON.stringify(import.meta.resolve("../../../src/altimate/learn/bootstrap-history"))
  const bootstrapModule = JSON.stringify(import.meta.resolve("../../../src/altimate/learn/bootstrap"))
  const promptsModule = JSON.stringify(import.meta.resolve("@clack/prompts"))
  await fs.writeFile(file, `
import { mock } from "bun:test"
import fs from "node:fs/promises"
const at = Date.now() - 86_400_000
mock.module(${historyModule}, () => ({
  historySessions: function* (scope) {
    yield { id: "ses_bootstrap_cli", projectID: scope.projectID, directory: scope.directory, time: { created: at, updated: at } }
  },
  historySession: () => undefined,
  historyMessages: function* (sessionID) {
    yield { info: { id: "msg_first", sessionID, role: "user" }, parts: [{ type: "text", text: "No, this initial request is not a correction." }] }
    yield { info: { id: "msg_assistant", sessionID, role: "assistant", time: { completed: at }, providerID: "fake", modelID: "model" }, parts: [{ type: "text", text: "Used select star." }] }
    yield { info: { id: "msg_correction", sessionID, role: "user" }, parts: [{ type: "text", text: "No, list columns explicitly. password=fixture-secret" }] }
  },
}))
const original = await import(${bootstrapModule})
const bootstrap = original.bootstrap
mock.module(${bootstrapModule}, () => ({
  ...original,
  bootstrap: (options, deps) => bootstrap(options, {
    ...deps,
    resolveModel: async () => ({
      providerID: "fake", modelID: "model", cost: { input: 1, output: 2 },
      generate: async (abortSignal, onUsage) => async (request) => {
        process.stdout.write("MODEL_CALL\\n")
        await fs.appendFile(${JSON.stringify(path.join(cwd, "model-requests.jsonl"))}, JSON.stringify(request) + "\\n")
        onUsage({ inputTokens: 41, outputTokens: 9 })
        return { deltas: [{ op: "ADD", text: "List columns explicitly in SQL queries.", reason: "user correction" }] }
      },
    }),
  }),
}))
${confirmation === undefined ? "" : `
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
const prompts = await import(${promptsModule})
mock.module(${promptsModule}, () => ({
  ...prompts,
  confirm: async ({ message }) => { process.stdout.write("CONFIRM: " + message + "\\n"); return ${confirmation} },
}))
`}
`)
  return file
}

describe("learn bootstrap CLI", () => {
  test("help documents privacy, limits and review steps", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--help"])
    expect(result.code).toBe(0)
    for (const text of ["--since", "--limit", "--max-reflections", "--max-seconds", "--model", "--yes", "--dry-run", "redacted excerpts of past sessions", "learn promote"])
      expect(result.stdout + result.stderr).toContain(text)
  }, 60_000)

  test("dry-run prints scope and redacted signals without sending or writing", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "fake/model", "--dry-run"], await fixture(dir.path))
    expect(result.code).toBe(0)
    for (const text of ["Bootstrap scope: 1 root session(s)", "Date range:", "Signals found: 1", "1 corrections", "0 tool failures", "fake/model", "Estimated input tokens:", "[user_correction]", "password=[REDACTED]", "nothing sent"])
      expect(result.stdout).toContain(text)
    expect(result.stdout).not.toContain("fixture-secret")
    expect(result.stdout).not.toContain("MODEL_CALL")
    expect(result.stdout).not.toContain("CONFIRM:")
    expect(await Bun.file(bootstrapStateFile(dir.path)).exists()).toBe(false)
    expect(await Store.readCandidate(dir.path, DEFAULT_NAME)).toBeUndefined()
    expect(await readSignals(dir.path)).toEqual([])
  }, 60_000)

  test("non-TTY without --yes refuses after showing scope", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "fake/model"], await fixture(dir.path))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain("Bootstrap scope: 1 root session(s)")
    expect(result.stdout + result.stderr).toContain("pass --yes or --dry-run")
    expect(result.stdout).not.toContain("MODEL_CALL")
    expect(await Bun.file(bootstrapStateFile(dir.path)).exists()).toBe(false)
  }, 60_000)

  test.each([false, true])("TTY confirmation=%s occurs after scope and before model calls", async (confirmed) => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "fake/model"], await fixture(dir.path, confirmed))
    expect(result.code).toBe(0)
    expect(result.stdout.indexOf("CONFIRM:")).toBeGreaterThan(result.stdout.indexOf("Estimated input tokens:"))
    if (!confirmed) {
      expect(result.stdout).toContain("Cancelled. Nothing sent.")
      expect(result.stdout).not.toContain("MODEL_CALL")
      expect(await Bun.file(bootstrapStateFile(dir.path)).exists()).toBe(false)
      return
    }
    expect(result.stdout.indexOf("MODEL_CALL")).toBeGreaterThan(result.stdout.indexOf("CONFIRM:"))
    expect(result.stdout).toContain("1 reflections run")
    expect(await Store.readCandidate(dir.path, DEFAULT_NAME)).toContain("List columns explicitly")
    expect(await Store.readPromoted(dir.path, DEFAULT_NAME)).toBeUndefined()
  }, 60_000)

  test("--yes runs without prompting, reports usage and leaves unrelated replacement feedback queued", async () => {
    await using dir = await tmpdir({ git: true })
    const pending = [{ id: "L-aaaa", text: "Keep old rows.", reasons: ["old review"], feedback: "UNSELECTED SESSION EXCERPT", kind: "review" as const, attempts: 1 }]
    await Store.writePendingReplacements(dir.path, DEFAULT_NAME, pending)
    const result = await run(dir.path, ["--model", "fake/model", "--yes"], await fixture(dir.path))
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain("CONFIRM:")
    expect(result.stdout).toContain("candidate lessons: 1 added, 0 edited")
    expect(result.stdout).toContain("41 input, 9 output")
    expect(result.stdout).toContain("$0.000059")
    expect(result.stdout).toContain("`learn show`")
    expect(result.stdout).toContain("`learn promote`")
    const requests = await fs.readFile(path.join(dir.path, "model-requests.jsonl"), "utf8")
    expect(requests.trim().split("\n")).toHaveLength(1)
    expect(requests).not.toContain("fixture-secret")
    expect(requests).not.toContain("UNSELECTED SESSION EXCERPT")
    expect(await Store.readPendingReplacements(dir.path, DEFAULT_NAME)).toEqual(pending)
    expect((await readSignals(dir.path))[0]).toMatchObject({ status: "consumed", source: "bootstrap" })
    expect(await Store.readPromoted(dir.path, DEFAULT_NAME)).toBeUndefined()
  }, 60_000)

  test("an explicit unconfigured model can preview empty real history without resolving a provider", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, ["--model", "fake/model", "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Bootstrap scope: 0 root session(s)")
    expect(result.stdout).toContain("Model/provider: none (no reflections). Estimated input tokens: 0 for up to 0 reflection(s)")
    expect(result.stdout).toContain("Bootstrap imports signals locally without model calls.")
    expect(await Bun.file(bootstrapStateFile(dir.path)).exists()).toBe(false)
  }, 60_000)

  test.each([
    [["--limit", "0"], "--limit must be an integer >= 1"],
    [["--max-reflections", "-1"], "--max-reflections must be an integer >= 0"],
    [["--max-seconds", "0"], "--max-seconds must be an integer >= 1"],
    [["--since", "yesterday-ish"], "--since must be a past ISO date"],
    [["--model", "invalid"], "Invalid model (expected provider/model)"],
  ])("rejects invalid options %j before model calls", async (args, message) => {
    await using dir = await tmpdir({ git: true })
    const result = await run(dir.path, [...args, "--dry-run"], await fixture(dir.path))
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain(message)
    expect(result.stdout).not.toContain("MODEL_CALL")
    expect(await Bun.file(bootstrapStateFile(dir.path)).exists()).toBe(false)
  }, 60_000)
})
