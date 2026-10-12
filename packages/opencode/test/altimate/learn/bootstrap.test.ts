// altimate_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bootstrap, bootstrapSince, type BootstrapDeps, type BootstrapOptions } from "../../../src/altimate/learn/bootstrap"
import type { HistorySession } from "../../../src/altimate/learn/bootstrap-history"
import type { MessageV2 } from "../../../src/session/message-v2"
import { makeGenerate, type Generate, type GenerateUsage } from "../../../src/altimate/learn/reflect"
import { claimsDirectory, createClaimManager } from "../../../src/altimate/learn/claims"
import { readBootstrapState, updateBootstrapState } from "../../../src/altimate/learn/bootstrap-state"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Store from "../../../src/altimate/learn/store"
import { DEFAULT_NAME } from "../../../src/altimate/learn/playbook"

const NOW = Date.parse("2026-10-02T12:00:00Z")
let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "learn-bootstrap-")) })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

function message(session: string, id: string, role: "user" | "assistant", text: string, completed = true): MessageV2.WithParts {
  return {
    info: { id, sessionID: session, role, time: { created: NOW - 100, ...(role === "assistant" && completed ? { completed: NOW - 90 } : {}) } },
    parts: [{ id: `${id}_text`, sessionID: session, messageID: id, type: "text", text }],
  } as unknown as MessageV2.WithParts
}

function transcript(id: string, correction = `No, use explicit columns for ${id}.`) {
  return [message(id, `${id}_first`, "user", "No, first messages are tasks."),
    message(id, `${id}_assistant`, "assistant", "Completed the task."),
    message(id, `${id}_correction`, "user", correction)]
}

function harness(input: { ids?: string[]; messages?: Record<string, MessageV2.WithParts[]>; generate?: Generate; usage?: GenerateUsage[] } = {}) {
  const sessions: HistorySession[] = (input.ids ?? ["session"]).map((id, index) => ({
    id, projectID: "project", directory: root, time: { created: NOW - (index + 1) * 86_400_000, updated: NOW - 1 },
  }))
  const output: string[] = []
  const prompts: string[] = []
  const readSessions: string[] = []
  const queries: unknown[] = []
  let factories = 0
  let confirms = 0
  const deps: BootstrapDeps = {
    isTTY: true, now: () => NOW, out: (text) => output.push(text),
    confirm: async () => { confirms++; return true },
    resolveModel: async () => ({
      providerID: "test", modelID: "small", cost: { input: 2, output: 4, cache: { read: 0.2, write: 2.5 } },
      generate: async (_abort, usage) => {
        factories++
        return async (request) => {
          prompts.push(request.prompt)
          usage(input.usage?.[prompts.length - 1] ?? { inputTokens: 100, outputTokens: 25 })
          return input.generate ? input.generate(request) : { deltas: [] }
        }
      },
    }),
    history: {
      *sessions(query) {
        queries.push(query)
        yield* sessions.filter((s) => s.projectID === query.projectID && s.directory === query.directory &&
          s.time.created >= query.since && (!query.before || s.time.created < query.before.created ||
            (s.time.created === query.before.created && s.id < query.before.id))).slice(0, query.limit)
      },
      session: (query) => sessions.find((s) => s.id === query.sessionID && s.projectID === query.projectID && s.directory === query.directory),
      *messages(id) {
        readSessions.push(id)
        yield* input.messages?.[id] ?? transcript(id)
      },
    },
  }
  const run = (options: Partial<BootstrapOptions> = {}) => bootstrap({ root, projectID: "project", directory: root, ...options }, deps)
  return { run, deps, output, prompts, readSessions, queries, sessions, factories: () => factories, confirms: () => confirms }
}

describe("bootstrap consent and extraction", () => {
  test.each([false, true])("zero reflections imports signals without resolving a model (dry run: %s)", async (dryRun) => {
    const h = harness()
    h.deps.resolveModel = async () => { throw new Error("No default model configured") }
    const summary = await h.run({ yes: true, maxReflections: 0, dryRun })
    expect(h.factories()).toBe(0)
    expect(h.output.join("\n")).toContain("Estimated input tokens: 0 for up to 0 reflection(s)")
    if (dryRun) {
      expect(summary).toBeUndefined()
      expect(await fs.readdir(root)).toEqual([])
    } else {
      expect(summary).toMatchObject({ signalsFound: 1, signalsAdded: 1, reflectionsRun: 0 })
      expect((await Signals.listSignals(root)).map((signal) => signal.status)).toEqual(["open"])
      expect((await readBootstrapState(root)).pendingSessions).toEqual(["session"])
    }
  })

  test("an empty signal import does not require a model", async () => {
    const h = harness({ messages: { session: transcript("session").slice(0, 2) } })
    h.deps.resolveModel = async () => { throw new Error("No default model configured") }
    expect(await h.run({ yes: true })).toMatchObject({ signalsFound: 0, reflectionsRun: 0 })
    expect(h.factories()).toBe(0)
  })

  test("dry run prints scope and redacted signals without model calls, confirmation, or writes", async () => {
    const h = harness({ messages: { session: transcript("session", "No, use key sk-abcdef1234567890XYZ instead.") } })
    await h.run({ dryRun: true })
    const output = h.output.join("\n")
    expect(output).toContain("1 root session(s)")
    expect(output).toContain("Date range: 2026-10-01T12:00:00.000Z")
    expect(output).toContain("Signals found: 1 (1 corrections, 0 tool failures")
    expect(output).toContain("Model/provider: test/small")
    expect(output).toMatch(/Estimated input tokens: [1-9]\d*/)
    expect(output).toContain("[REDACTED]")
    expect(output).not.toContain("sk-abcdef1234567890XYZ")
    expect(output).not.toContain("first messages are tasks")
    expect(h.factories()).toBe(0)
    expect(h.confirms()).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
  })

  test("non-TTY refuses after showing scope unless --yes is explicit", async () => {
    const h = harness()
    h.deps.isTTY = false
    await expect(h.run()).rejects.toThrow("pass --yes or --dry-run")
    expect(h.output.join("\n")).toContain("Bootstrap scope")
    expect(h.factories()).toBe(0)
    expect(h.confirms()).toBe(0)
    expect(await fs.readdir(root)).toEqual([])
    expect(await h.run({ yes: true })).toMatchObject({ signalsFound: 1, reflectionsRun: 1 })
    expect(h.factories()).toBe(1)
  })

  test("TTY prints the entire scope before asking and cancellation leaves no state", async () => {
    const h = harness()
    h.deps.confirm = async () => {
      expect(h.output.join("\n")).toContain("Estimated input tokens")
      expect(h.output.join("\n")).toContain("sends redacted excerpts")
      expect(h.factories()).toBe(0)
      return false
    }
    await h.run()
    expect(h.output.at(-1)).toContain("Cancelled")
    expect(await fs.readdir(root)).toEqual([])
  })

  test("reuses correction classification and retry threshold; excludes the first prompt and incomplete assistants", async () => {
    const messages = transcript("session")
    messages.splice(1, 0, message("session", "incomplete", "assistant", "Working", false),
      message("session", "before_completion", "user", "No, unfinished output is not a correction."))
    const assistant = message("session", "tools", "assistant", "")
    assistant.parts = Array.from({ length: 4 }, (_, index) => ({
      id: `p${index}`, sessionID: "session", messageID: "tools", type: "tool", tool: "bash", callID: `call${index}`,
      state: { status: "error", input: {}, error: "failed with sk-abcdef1234567890XYZ", time: { start: 1, end: 2 } },
    })) as unknown as MessageV2.Part[]
    messages.push(assistant, message("session", "ordinary", "user", "Thanks, please continue."))
    const h = harness({ messages: { session: messages } })
    const summary = await h.run({ yes: true })
    expect(summary).toMatchObject({ signalsFound: 2, signalsAdded: 2, reflectionsRun: 1 })
    const signals = await Signals.readSignals(root)
    expect(signals.map((s) => s.kind)).toEqual(["user_correction", "tool_retry"])
    expect(signals[1]).toMatchObject({ source: "bootstrap", partID: "p2" })
    expect(JSON.stringify(signals)).not.toContain("sk-abcdef1234567890XYZ")
    expect(h.prompts.join("\n")).not.toContain("sk-abcdef1234567890XYZ")
  })

  test("the first user message is ignored even when history begins with a completed assistant", async () => {
    const h = harness({ messages: { session: [
      message("session", "leading_assistant", "assistant", "An earlier imported response."),
      message("session", "first_user", "user", "No, use names from the initial request."),
      message("session", "next_assistant", "assistant", "Done."),
      message("session", "second_user", "user", "No, use explicit column names."),
    ] } })
    expect(await h.run({ yes: true })).toMatchObject({ signalsFound: 1, signalsAdded: 1 })
    expect((await Signals.readSignals(root)).map((signal) => signal.messageID)).toEqual(["second_user"])
  })
})

describe("bootstrap continuation and reflection", () => {
  test("rejected-only reflection advances through every batch and session without repeating signals", async () => {
    const messages = transcript("older").slice(0, 2)
    for (let i = 0; i < 7; i++) messages.push(message("older", `correction${i}`, "user", `No, use explicit columns. ${"x".repeat(1950)}`))
    const h = harness({ ids: ["newer", "older"], messages: { older: messages }, generate: async () => ({
      deltas: [{ op: "ADD", text: "Read https://example.com/conventions before editing.", reason: "review" }],
    }) })
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 8, reflectionsRun: 3, failures: 0 })
    expect(await Signals.listSignals(root)).toEqual([])
    expect((await readBootstrapState(root)).pendingSessions).toEqual([])
    expect(h.prompts[0]).not.toContain("columns for newer")
    expect(h.prompts[2]).toContain("columns for newer")
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 0 })
    expect(h.prompts).toHaveLength(3)
  })

  test("selected sessions are streamed and reflected oldest first within limit and date scope", async () => {
    const h = harness({ ids: ["newest", "middle", "oldest"] })
    expect(await h.run({ yes: true, limit: 2, since: "2d" })).toMatchObject({ signalsFound: 2, reflectionsRun: 2 })
    expect(h.readSessions).toEqual(["middle", "newest"])
    expect(h.prompts[0]).toContain("columns for middle")
    expect(h.prompts[1]).toContain("columns for newest")
    expect(h.queries[0]).toMatchObject({ projectID: "project", directory: root, limit: 2, since: NOW - 2 * 86_400_000 })
  })

  test("a cursor from another project or directory cannot skip this scope's newest sessions", async () => {
    for (const scope of [{ projectID: "other-project", directory: root }, { projectID: "project", directory: `${root}/other` }]) {
      await updateBootstrapState(root, (state) => {
        state.scope = scope
        state.cursor = { created: NOW - 2 * 86_400_000, id: "middle" }
      })
      const h = harness({ ids: ["newest", "middle", "oldest"] })
      await h.run({ dryRun: true, limit: 1 })
      expect(h.readSessions).toEqual(["newest"])
      expect(h.queries[0]).toMatchObject({ before: undefined })
    }
  })

  test("narrowing --since past the saved cursor starts a fresh eligible window", async () => {
    await updateBootstrapState(root, (state) => {
      state.scope = { projectID: "project", directory: root }
      state.cursor = { created: NOW - 20 * 86_400_000, id: "older_cursor" }
    })
    const h = harness({ ids: ["newest", "middle", "oldest"] })
    await h.run({ dryRun: true, since: "2d", limit: 1 })
    expect(h.readSessions).toEqual(["newest"])
    expect(h.queries[0]).toMatchObject({ before: undefined, since: NOW - 2 * 86_400_000 })
  })

  test("reflection limits persist unfinished work, then traversal cursor continues older sessions without duplicate signals", async () => {
    const h = harness({ ids: ["newest", "middle", "oldest"] })
    expect(await h.run({ yes: true, limit: 2, maxReflections: 1 })).toMatchObject({ signalsAdded: 2, reflectionsRun: 1 })
    expect((await readBootstrapState(root)).cursor?.id).toBe("middle")
    expect(await h.run({ yes: true, limit: 2, maxReflections: 1 })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(await h.run({ yes: true, limit: 2 })).toMatchObject({ signalsAdded: 1, reflectionsRun: 1 })
    expect(await Signals.readSignals(root)).toHaveLength(3)
    expect((await readBootstrapState(root)).pendingSessions).toEqual([])
    expect(await h.run({ yes: true, limit: 3 })).toMatchObject({ signalsFound: 0, signalsAdded: 0, reflectionsRun: 0 })
  })

  test("large sessions respect the existing feedback budget and finish on a later run", async () => {
    const messages = transcript("session").slice(0, 2)
    for (let i = 0; i < 7; i++) messages.push(message("session", `correction${i}`, "user", `No, use explicit columns. ${"x".repeat(1950)}`))
    const h = harness({ messages: { session: messages } })
    expect(await h.run({ yes: true, maxReflections: 1 })).toMatchObject({ signalsAdded: 7, reflectionsRun: 1 })
    expect((await Signals.listSignals(root)).length).toBeGreaterThan(0)
    expect(await h.run({ yes: true })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(await Signals.listSignals(root)).toEqual([])
    for (const prompt of h.prompts) {
      const feedback = prompt.split('<feedback kind="user" untrusted="true">\n')[1].split("\n</feedback>")[0]
      expect(feedback.length).toBeLessThanOrEqual(12_000)
    }
  })

  test("lowering --limit resumes the oldest pending correction before newer sessions", async () => {
    const h = harness({ ids: ["newest", "middle", "oldest"] })
    await h.run({ yes: true, maxReflections: 0 })
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["oldest", "middle", "newest"])
    expect(await h.run({ yes: true, limit: 1 })).toMatchObject({ signalsAdded: 0, reflectionsRun: 1 })
    expect(h.prompts[0]).toContain("columns for oldest")
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["middle", "newest"])
  })

  test("signals arriving during a reflection remain queued for a separately consented run", async () => {
    let inject = true
    const h = harness({ generate: async () => {
      if (inject) {
        inject = false
        await Signals.appendSignal(root, { kind: "user_correction", sessionID: "session", messageID: "arrived_later",
          source: "bootstrap", text: "No, qualify joined column names.", reason: "correction" })
      }
      return { deltas: [] }
    } })
    expect(await h.run({ yes: true })).toMatchObject({ signalsFound: 1, reflectionsRun: 1 })
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["session"])
    expect((await Signals.listSignals(root)).map((signal) => signal.messageID)).toEqual(["arrived_later"])
    expect(h.prompts[0]).not.toContain("qualify joined column names")
    expect(await h.run({ yes: true })).toMatchObject({ signalsFound: 1, signalsAdded: 0, reflectionsRun: 1 })
    expect(h.prompts[1]).toContain("qualify joined column names")
  })

  test("a claimed batch cannot invoke the model; release allows a later bootstrap run", async () => {
    const h = harness()
    await h.run({ yes: true, maxReflections: 0 })
    const signals = await Signals.listSignals(root)
    const other = createClaimManager({ pid: 123, host: "other-process", isAlive: () => true })
    const claim = await other.acquire(root, DEFAULT_NAME, signals.map((signal) => signal.id))
    expect(claim).toBeDefined()
    try {
      expect(await h.run({ yes: true })).toMatchObject({ reflectionsRun: 0 })
      expect(h.factories()).toBe(0)
      expect(await Signals.listSignals(root)).toHaveLength(1)
    } finally { await claim!.release() }
    expect(await h.run({ yes: true })).toMatchObject({ reflectionsRun: 1 })
    expect(await Signals.listSignals(root)).toEqual([])
    expect(await fs.readdir(claimsDirectory(root))).toEqual([])
  })

  test("reports candidate ADD/EDIT counts, measured token usage and cost without promotion", async () => {
    let count = 0
    const h = harness({ ids: ["newer", "older"], generate: async () => {
      expect((await fs.readdir(claimsDirectory(root))).length).toBe(1)
      if (count++ === 0) return { deltas: [{ op: "ADD", text: "List query result columns explicitly.", reason: "correction" }] }
      const [lesson] = (await Store.loadCandidateLessons(root, DEFAULT_NAME))!
      return { deltas: [{ op: "EDIT", id: lesson.id, text: "List query result columns explicitly and qualify joined column names.", reason: "later correction" }] }
    } })
    const summary = await h.run({ yes: true })
    expect(summary).toMatchObject({ signalsFound: 2, signalsAdded: 2, reflectionsRun: 2,
      candidatesAdded: 1, candidatesEdited: 1, inputTokens: 200, outputTokens: 50, tokensEstimated: false, estimatedCost: 0.0006 })
    expect(await Store.loadApproved(root, DEFAULT_NAME)).toEqual([])
    expect((await Store.loadCandidateLessons(root, DEFAULT_NAME))![0].text).toContain("qualify joined column names")
    expect(h.output.join("\n")).toContain("candidate lessons: 1 added, 1 edited")
    expect(h.output.join("\n")).toContain("`learn show`, then `learn promote`")
  })

  test("model failure keeps feedback pending and stops before newer corrections", async () => {
    const h = harness({ ids: ["newer", "older"], generate: async () => { throw new Error("unavailable sk-abcdef1234567890XYZ") } })
    expect(await h.run({ yes: true })).toMatchObject({ reflectionsRun: 1, failures: 1 })
    expect(await Signals.listSignals(root)).toHaveLength(2)
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["older", "newer"])
    expect(h.output.join("\n")).not.toContain("sk-abcdef1234567890XYZ")
  })

  test("sums accounted call costs and persists the same usage in each reflection history", async () => {
    const usage = [
      { inputTokens: 100, outputTokens: 25, estimatedCost: 0.004 },
      { inputTokens: 150, outputTokens: 35, estimatedCost: 0.007 },
    ]
    const h = harness({ ids: ["newer", "older"], usage })
    expect(await h.run({ yes: true })).toMatchObject({
      reflectionsRun: 2, inputTokens: 250, outputTokens: 60, estimatedCost: 0.011, tokensEstimated: false,
    })
    const history = (await fs.readFile(Store.paths(root, DEFAULT_NAME).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(history.map((entry) => entry.usage)).toEqual(usage)
    expect(h.output.join("\n")).toContain("Estimated cost: $0.011000")
  })

  for (const failed of [false, true]) test(`estimates missing token usage and cost for ${failed ? "failed" : "completed"} calls`, async () => {
    const h = harness()
    const model = await h.deps.resolveModel()
    h.deps.resolveModel = async () => ({ ...model, generate: async () => async () => {
      if (failed) throw new Error("provider unavailable")
      return { deltas: [] }
    } })
    const summary = (await h.run({ yes: true }))!
    expect(summary).toMatchObject({ reflectionsRun: 1, failures: failed ? 1 : 0, tokensEstimated: true,
      outputTokens: failed ? 0 : Math.ceil(JSON.stringify({ deltas: [] }).length / 4) })
    expect(summary.inputTokens).toBeGreaterThan(0)
    expect(summary.estimatedCost).toBeCloseTo((summary.inputTokens * 2 + summary.outputTokens * 4) / 1_000_000, 10)
  })

  for (const partial of [{ inputTokens: 100 }, { outputTokens: 25 }]) test(`prices fallback tokens when provider usage only reports ${Object.keys(partial)[0]}`, async () => {
    const h = harness()
    const model = await h.deps.resolveModel()
    h.deps.resolveModel = async () => ({ ...model, generate: async (abort, onUsage) => makeGenerate(
      {} as never, {}, 1_000,
      async () => ({ object: { deltas: [] }, usage: partial, providerMetadata: { anthropic: { cacheCreationInputTokens: 10 } } }),
      abort, onUsage, model,
    ) })
    const summary = (await h.run({ yes: true }))!
    expect(summary).toMatchObject({ reflectionsRun: 1, failures: 0, tokensEstimated: true,
      ...(partial.inputTokens !== undefined ? { inputTokens: partial.inputTokens + 10 } : { outputTokens: partial.outputTokens }) })
    expect(summary.inputTokens).toBeGreaterThan(0)
    expect(summary.outputTokens).toBeGreaterThan(0)
    expect(summary.estimatedCost).toBeCloseTo(((summary.inputTokens - 10) * 2 + 10 * 2.5 + summary.outputTokens * 4) / 1_000_000, 10)
  })

  test("deadline expiry stops before a second session and passes an abort signal to the provider", async () => {
    let clock = NOW
    let signal: AbortSignal | undefined
    const h = harness({ ids: ["newer", "older"] })
    h.deps.now = () => clock
    h.deps.resolveModel = async () => ({ providerID: "test", modelID: "timed", generate: async (abort) => {
      signal = abort
      return async () => { clock += 2_000; return { deltas: [] } }
    } })
    const summary = await h.run({ yes: true, maxSeconds: 1 })
    expect(summary?.reflectionsRun).toBe(1)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(await Signals.listSignals(root)).toHaveLength(2)
    expect(h.output.join("\n")).toContain("Unfinished signals remain queued")
  })

  test("hung provider initialization times out and cannot start a late model call after setup resolves", async () => {
    let finish!: (generate: Generate) => void
    const setup = new Promise<Generate>((resolve) => { finish = resolve })
    let calls = 0
    let abortSignal: AbortSignal | undefined
    const h = harness()
    h.deps.resolveModel = async () => ({
      providerID: "test", modelID: "hung-setup",
      generate: async (signal) => { abortSignal = signal; return setup },
    })
    const started = performance.now()
    const summary = await h.run({ yes: true, maxSeconds: 1 })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(4_000)
    expect(summary).toMatchObject({ failures: 1, inputTokens: 0, outputTokens: 0 })
    expect(abortSignal?.aborted).toBe(true)
    expect((await Signals.listSignals(root)).map((signal) => signal.status)).toEqual(["open"])
    expect((await readBootstrapState(root)).pendingSessions).toEqual(["session"])
    expect(await fs.readdir(claimsDirectory(root))).toEqual([])
    finish(async () => { calls++; return { deltas: [] } })
    // Flush the abandoned setup continuation, including any accidentally scheduled model call.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(0)
    expect(await Signals.listSignals(root)).toHaveLength(1)
    expect(await Store.loadCandidateLessons(root, DEFAULT_NAME)).toBeUndefined()
    expect(h.output.join("\n")).toContain("time budget exhausted")
  })
})

test("bootstrap dates reject future/invalid boundaries and accept durations and inclusive ISO dates", () => {
  expect(bootstrapSince("30d", NOW)).toBe(NOW - 30 * 86_400_000)
  expect(bootstrapSince("2026-10-01", NOW)).toBe(Date.parse("2026-10-01"))
  for (const value of ["invalid", "-1d", "2030-01-01", "999999999999999d"]) expect(() => bootstrapSince(value, NOW)).toThrow("--since")
})
