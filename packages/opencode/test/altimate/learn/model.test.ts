// altimate_change - new file
import { afterEach, expect, spyOn, test } from "bun:test"
import path from "node:path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { MessageID } from "../../../src/session/schema"
import { ProviderID, ModelID } from "../../../src/provider/schema"
import { FreeTier } from "../../../src/altimate/free/client"
import { LearnCommand } from "../../../src/cli/cmd/learn"
import { autoReflectSession } from "../../../src/altimate/learn/auto"
import * as Signals from "../../../src/altimate/learn/signals"

const envKeys = ["ALTIMATE_LEARN_MODEL", "ALTIMATE_LEARN_CAPTURE", "ALTIMATE_LEARN_AUTO"] as const
const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const cases = [
  { name: "auto uses the most recent assistant model", mode: "auto", expected: "session/b" },
  { name: "manual signals use the most recent assistant model", mode: "signals", expected: "session/b" },
  { name: "manual feedback uses the most recent assistant model", mode: "feedback", expected: "session/b" },
  { name: "pending sessions each use their own model", mode: "pending", expected: "session/b,session/c" },
  { name: "explicit -m wins over environment, config and session", mode: "signals", config: "c", env: "d", explicit: "e", expected: "reflection/e" },
  { name: "manual config wins over the session", mode: "feedback", config: "c", expected: "reflection/c" },
  { name: "manual environment wins over config and session", mode: "signals", config: "c", env: "d", expected: "reflection/d" },
  { name: "auto config wins over the session", mode: "auto", config: "c", expected: "reflection/c" },
  { name: "auto environment wins over config and session", mode: "auto", config: "c", env: "d", expected: "reflection/d" },
  { name: "external-only signals fall back to the global default", mode: "external", expected: "reflection/a" },
  { name: "trajectory uses the last generation model", mode: "trajectory", expected: "session/b" },
  { name: "trajectory retains its model across a trailing step without generation metadata", mode: "trajectory-trailing", expected: "session/b" },
  { name: "trajectory without a model falls back to the global default", mode: "trajectory-empty", expected: "reflection/a" },
] as const

test.each([...cases])("reflection model: $name", async (entry) => {
  const requestModels: string[] = []
  const realFetch = globalThis.fetch
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const provider = new URL(request.url).hostname.split(".")[0]
    // Only the fake model providers are intercepted; unrelated startup traffic (e.g. a ripgrep
    // download on a machine without a cached binary) goes to the real fetch.
    if (!["reflection", "session"].includes(provider)) return realFetch(input, init)
    const body = await request.json() as { model: string }
    requestModels.push(`${provider}/${body.model}`)
    return Response.json({
      id: "reflection",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: '{"deltas":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }, { preconnect: () => {} }))
  const register = spyOn(FreeTier, "autoRegisterWithin").mockResolvedValue({ status: "pending" })
  const output = spyOn(process.stdout, "write").mockReturnValue(true)
  const cwd = process.cwd()
  try {
    delete process.env.ALTIMATE_LEARN_MODEL
    process.env.ALTIMATE_LEARN_CAPTURE = "1"
    process.env.ALTIMATE_LEARN_AUTO = "1"
    if ("env" in entry) process.env.ALTIMATE_LEARN_MODEL = `reflection/${entry.env}`
    await using dir = await tmpdir({
      git: true,
      config: {
        model: "reflection/a",
        learn: { capture: true, auto_reflect: true, ...("config" in entry ? { model: `reflection/${entry.config}` } : {}) },
        provider: Object.fromEntries(["reflection", "session"].map((provider) => [
          provider, {
            npm: "@ai-sdk/openai-compatible",
            name: "Reflection test",
            options: { baseURL: `http://${provider}.test/v1` },
            models: Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, { name: id }])),
          },
        ])),
      },
    })
    const sessionIDs = await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const ids: string[] = []
        for (const latest of entry.mode === "pending" ? ["b", "c"] : ["b"]) {
          const session = await Session.create({})
          ids.push(session.id)
          for (const modelID of ["a", latest]) {
            await Session.updateMessage({
              id: MessageID.ascending(), sessionID: session.id, role: "assistant",
              parentID: MessageID.ascending(), time: { created: Date.now(), completed: Date.now() },
              providerID: ProviderID.make(modelID === "a" ? "reflection" : "session"), modelID: ModelID.make(modelID),
              mode: "build", agent: "build", path: { cwd: dir.path, root: dir.path }, cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }
          await Signals.appendSignal(dir.path, {
            kind: "review", sessionID: entry.mode === "external" ? Signals.EXTERNAL_SESSION : session.id,
            text: "Run unit tests before committing.", reason: "review",
          })
        }
        if (entry.mode === "auto") {
          expect(await autoReflectSession(ids[0])).toMatchObject({ ok: true })
        }
        return ids
      },
    })
    if (entry.mode !== "auto") {
      const args = ["learn", "reflect", "--json"]
      if (entry.mode === "pending") args.push("--pending")
      else if (entry.mode.startsWith("trajectory")) {
        const file = path.join(dir.path, "trajectory.json")
        await Bun.write(file, JSON.stringify({ steps: entry.mode === "trajectory-empty" ? [] : [
          { generation: { provider_id: "reflection", model_id: "a" } },
          { generation: { provider_id: "session", model_id: "b" } },
          ...(entry.mode === "trajectory-trailing" ? [{ text: "Finished." }] : []),
        ] }))
        args.push("--trajectory", file)
      } else args.push("--session", entry.mode === "external" ? Signals.EXTERNAL_SESSION : sessionIDs[0])
      if (entry.mode === "feedback" || entry.mode.startsWith("trajectory")) {
        const file = path.join(dir.path, "feedback.txt")
        await Bun.write(file, "Run unit tests before committing.")
        args.push("--feedback", file)
      }
      if ("explicit" in entry) args.push("-m", `reflection/${entry.explicit}`)
      process.chdir(dir.path)
      await yargs(args).command(LearnCommand).exitProcess(false).parseAsync()
    }
    expect(requestModels).toEqual(entry.expected.split(","))
  } finally {
    process.chdir(cwd)
    register.mockRestore()
    output.mockRestore()
    fetch.mockRestore()
  }
}, 30_000)
