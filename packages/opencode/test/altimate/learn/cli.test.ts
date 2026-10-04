// altimate_change - new file
//
// Promotion review, `learn signal add`, `learn signals` and `learn reflect` without feedback, through the real CLI.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import * as Signals from "../../../src/altimate/learn/signals"
import * as Playbook from "../../../src/altimate/learn/playbook"
import * as Store from "../../../src/altimate/learn/store"
import { recordReflection } from "../../../src/altimate/learn/schedule-state"
import { tmpdir } from "../../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../../src/index.ts")

async function learn(cwd: string, ...args: string[]) {
  return runLearn(cwd, args)
}

async function runLearn(cwd: string, args: string[], preload?: string, env: Record<string, string> = {}) {
  return runCli(cwd, ["learn", ...args], preload, env)
}

async function runCli(cwd: string, args: string[], preload?: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", ...(preload ? ["--preload", preload] : []), entry, ...args], {
    cwd,
    env: {
      ...process.env, ALTIMATE_DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1",
      OPENCODE_TEST_STATE_HOME: path.join(cwd, "state"), ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

async function learnWithConfirmation(cwd: string, confirmed: boolean, args = ["promote"]) {
  // Keep the prompt stub and TTY state inside the CLI subprocess so other tests
  // still exercise real prompts and their own terminal state.
  const preload = path.join(cwd, "learn-confirm.ts")
  const prompts = JSON.stringify(import.meta.resolve("@clack/prompts"))
  await fs.writeFile(preload, `
import { mock } from "bun:test"
const original = await import(${prompts})
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
mock.module(${prompts}, () => ({
  ...original,
  confirm: async ({ message }) => {
    process.stdout.write("CONFIRM: " + message + "\\n")
    return ${confirmed}
  },
}))
`)
  return runLearn(cwd, args, preload)
}

test.each(["text", "json", "pending"])("learn reflect reports summed replacement usage (%s)", async (mode) => {
  await using dir = await tmpdir({ git: true })
  await Store.saveCandidate(dir.path, Playbook.DEFAULT_NAME, Playbook.withBullets(Playbook.create({ name: Playbook.DEFAULT_NAME }), [
    { id: "L-0001", text: "Convert `_cents` columns in staging.", helpful: 0, harmful: 0 },
  ]))
  const preload = path.join(dir.path, "learn-usage.ts")
  const reflector = JSON.stringify(import.meta.resolve("../../../src/altimate/learn/reflect"))
  const effect = JSON.stringify(import.meta.resolve("effect"))
  await fs.writeFile(preload, `
import { mock } from "bun:test"
import { Effect } from ${effect}
const initialSchema = {}
const original = await import(${reflector})
mock.module(${reflector}, () => ({
  ...original,
  providerGenerate: (_model, timeout, abortSignal, onUsage) => Effect.succeed(original.makeGenerate(
    {}, initialSchema, timeout,
    async ({ schema }) => ({
      object: schema === initialSchema
        ? { deltas: [{ op: "REMOVE", id: "L-0001", reason: "staging convention changed" }] }
        : { text: "Preserve raw integer values for \\u0060_cents\\u0060 columns in staging." },
      usage: { inputTokens: schema === initialSchema ? 100 : 200, outputTokens: schema === initialSchema ? 25 : 50 },
    }), abortSignal, onUsage, { cost: { input: 2, output: 4 } },
  )),
}))
`)
  const args = ["reflect", "--model", "fake/model"]
  if (mode === "pending") {
    await Signals.appendSignal(dir.path, {
      kind: "review", sessionID: "external", text: "Keep raw cents in staging.", reason: "review",
    })
    args.push("--pending", "--json")
  } else {
    const trajectory = path.join(dir.path, "trajectory.json")
    const feedback = path.join(dir.path, "review.txt")
    await fs.writeFile(trajectory, JSON.stringify({ steps: [] }))
    await fs.writeFile(feedback, "Keep raw cents in staging.")
    args.push("--trajectory", trajectory, "--feedback", feedback)
    if (mode === "json") args.push("--json")
  }
  const result = await runLearn(dir.path, args, preload)
  expect(result.code).toBe(0)
  if (mode === "text") {
    expect(result.stdout).toContain("300 input, 75 output")
    expect(result.stdout).toContain("$0.000900")
  } else {
    const parsed = JSON.parse(result.stdout)
    const report = mode === "pending" ? parsed[0] : parsed
    expect(report).toMatchObject({ inputTokens: 300, outputTokens: 75 })
    expect(report.estimatedCost).toBeCloseTo(0.0009, 10)
  }
  const history = JSON.parse((await fs.readFile(Store.paths(dir.path, Playbook.DEFAULT_NAME).history, "utf8")).trim())
  expect(history.usage).toMatchObject({ inputTokens: 300, outputTokens: 75 })
  expect(history.usage.estimatedCost).toBeCloseTo(0.0009, 10)
}, 60_000)

describe("learn pin and unpin", () => {
  test("pin/unpin round trip is visible in show and status for the named store", async () => {
    await using dir = await tmpdir({ git: true })
    const name = "custom-rules"
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
      { id: "L-0001", text: "Document naming conventions.", helpful: 0, harmful: 0 },
    ]))
    await Store.promote(dir.path, name)
    const pinned = await learn(dir.path, "pin", "L-0001", "--name", name)
    expect(pinned.code).toBe(0)
    expect(pinned.stdout).toContain("Pinned [L-0001]")
    const shown = await learn(dir.path, "show", "--name", name)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain("[L-0001] Document naming conventions. (pinned)")
    const status = await learn(dir.path, "status", "--name", name)
    expect(status.code).toBe(0)
    expect(status.stdout).toContain("Pinned lessons: 1 (L-0001)")
    const json = await learn(dir.path, "status", "--name", name, "--json")
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({ approved: 1, pinned: ["L-0001"] })

    const unpinned = await learn(dir.path, "unpin", "L-0001", "--name", name)
    expect(unpinned.code).toBe(0)
    expect(unpinned.stdout).toContain("Unpinned [L-0001]")
    expect((await Store.loadApproved(dir.path, name))[0].pinned).toBe(false)
    const after = await learn(dir.path, "show", "--name", name)
    expect(after.code).toBe(0)
    expect(after.stdout).not.toContain("(pinned)")
    const cleared = await learn(dir.path, "status", "--name", name, "--json")
    expect(cleared.code).toBe(0)
    expect(JSON.parse(cleared.stdout).pinned).toEqual([])
    expect(await Store.loadApproved(dir.path, Playbook.DEFAULT_NAME)).toEqual([])
  }, 60_000)

  test.each(["pin", "unpin"])("%s rejects unknown IDs with close matches from learn search", async (command) => {
    await using dir = await tmpdir({ git: true })
    const name = Playbook.DEFAULT_NAME
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
      { id: "L-1234", text: "Document naming conventions.", helpful: 0, harmful: 0 },
    ]))
    await Store.promote(dir.path, name)
    const before = await Store.readPromoted(dir.path, name)
    const search = await learn(dir.path, "search", "L-1235")
    expect(search.code).toBe(0)
    expect(search.stdout).toContain("[L-1234] approved: Document naming conventions.")
    const result = await learn(dir.path, command, "L-1235")
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Unknown approved lesson "L-1235"')
    expect(result.stderr).toContain("Close matches from `learn search`")
    expect(result.stderr).toContain(search.stdout.trim())
    expect(await Store.readPromoted(dir.path, name)).toBe(before)
  }, 60_000)
})

describe("learn opt-in and status", () => {
  test.each(["config", "env"])("status reports the learning kill switch disabled by %s", async (source) => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({
      learn: { enabled: source === "env", capture: true, auto_reflect: true },
    }))
    const env = { ALTIMATE_LEARN: source === "env" ? "FaLsE" : "", ALTIMATE_LEARN_CAPTURE: "1" }
    const shown = await runLearn(dir.path, ["status"], undefined, env)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain("Learning enabled: no")
    expect(shown.stdout).toContain("Capture: off; automatic reflection: off")
    expect(shown.stdout).toContain("learn.enabled=true or ALTIMATE_LEARN=1")
    const json = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({
      enabled: false,
      capture: false,
      auto_reflect: false,
      note: expect.stringContaining("learn.enabled=true or ALTIMATE_LEARN=1"),
    })

    // Explicit user actions remain available while automatic learning is disabled.
    const added = await runLearn(dir.path, ["signal", "add", "--kind", "review", "--text", "Use explicit columns."], undefined, env)
    expect(added.code).toBe(0)
    expect(added.stdout).toContain("Recorded")
    expect(await Signals.listSignals(dir.path)).toHaveLength(1)
  }, 60_000)

  test.each(["config", "env"])("enable preserves the learning kill switch disabled by %s", async (source) => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ learn: { enabled: source === "env", capture: false, auto_reflect: false } }))
    const env = { ALTIMATE_LEARN: source === "env" ? "0" : "" }
    const result = await runLearn(dir.path, ["enable"], undefined, env)
    expect(result.code).toBe(0)
    expect(parseJsonc(await fs.readFile(file, "utf8")).learn).toEqual({
      enabled: source === "env", capture: true, auto_reflect: true,
    })
    expect(result.stdout).not.toContain("Project learning enabled")
    expect(result.stdout).toContain("Learning stays disabled")
    expect(result.stdout).toContain("learn.enabled=true or ALTIMATE_LEARN=1")
    const status = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).enabled).toBe(false)
  }, 60_000)

  test("status honors the learning environment override when config disables learning", async () => {
    await using dir = await tmpdir({ git: true })
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({ learn: { enabled: false } }))
    const result = await runLearn(dir.path, ["status", "--json"], undefined, { ALTIMATE_LEARN: "TrUe" })
    expect(result.code).toBe(0)
    const status = JSON.parse(result.stdout)
    expect(status).toMatchObject({ enabled: true, capture: false, auto_reflect: false })
    expect(status.note).toBeUndefined()
  }, 60_000)

  test("CLI state defaults to the test project and accepts an explicit override", async () => {
    await using dir = await tmpdir({ git: true })
    const inherited = process.env.OPENCODE_TEST_STATE_HOME
    const parentState = path.join(dir.path, "parent-state")
    process.env.OPENCODE_TEST_STATE_HOME = parentState
    try {
      const result = await learn(dir.path, "enable")
      expect(result.code).toBe(0)
      expect(await Bun.file(path.join(parentState, "learn-nudge.json")).exists()).toBe(false)
      expect(JSON.parse(await fs.readFile(path.join(dir.path, "state", "learn-nudge.json"), "utf8")).dismissed).toBe(true)
      const explicit = path.join(dir.path, "explicit-state")
      expect((await runLearn(dir.path, ["nudge", "off"], undefined, { OPENCODE_TEST_STATE_HOME: explicit })).code).toBe(0)
      expect(JSON.parse(await fs.readFile(path.join(explicit, "learn-nudge.json"), "utf8")).dismissed).toBe(true)
    } finally {
      if (inherited === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
      else process.env.OPENCODE_TEST_STATE_HOME = inherited
    }
  }, 60_000)

  test("learn invocations are attributed to learn in telemetry", async () => {
    await using dir = await tmpdir({ git: true })
    const preload = path.join(dir.path, "command-telemetry.ts")
    await fs.writeFile(preload, `process.on("exit", () => process.stderr.write("COMMAND: " + process.env.ALTIMATE_CLI_COMMAND + "\\n"))`)
    const result = await runLearn(dir.path, ["status", "--json"], preload)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("COMMAND: learn")
  }, 60_000)

  test.each(["opencode.json", "opencode.jsonc", ".altimate-code/opencode.jsonc", ".opencode/opencode.json"])(
    "enable and disable update discovered subdirectory config %s", async (relative) => {
      await using dir = await tmpdir({ git: true })
      const nested = path.join(dir.path, "nested")
      const cwd = path.join(nested, "child")
      const file = path.join(nested, relative)
      await fs.mkdir(cwd, { recursive: true })
      await fs.mkdir(path.dirname(file), { recursive: true })
      const before = JSON.stringify({ $schema: "https://altimate.ai/config.json", learn: { capture: false, auto_reflect: false } })
      await fs.writeFile(path.join(dir.path, "opencode.json"), before)
      await fs.writeFile(file, before)
      const env = { OPENCODE_TEST_STATE_HOME: path.join(dir.path, "state") }
      for (const [command, enabled] of [["enable", true], ["disable", false]] as const) {
        const result = await runLearn(cwd, [command], undefined, env)
        expect(result.code).toBe(0)
        expect(result.stdout).toContain(`Project config: ${file}`)
        expect(parseJsonc(await fs.readFile(file, "utf8")).learn).toEqual({ capture: enabled, auto_reflect: enabled })
        const status = await runLearn(cwd, ["status", "--json"], undefined, env)
        expect(status.code).toBe(0)
        expect(JSON.parse(status.stdout)).toMatchObject({ capture: enabled, auto_reflect: enabled })
        expect(await fs.readFile(path.join(dir.path, "opencode.json"), "utf8")).toBe(before)
      }
    }, 60_000,
  )

  test("enable succeeds and logs when a stale nudge staging file prevents dismissal", async () => {
    await using dir = await tmpdir({ git: true })
    const state = path.join(dir.path, "state")
    await fs.mkdir(state)
    await fs.writeFile(path.join(state, "learn-nudge.json.tmp"), "interrupted writer")
    const env = { OPENCODE_TEST_STATE_HOME: state }
    const result = await runLearn(dir.path, ["enable", "--print-logs"], undefined, env)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Project learning enabled")
    expect(result.stderr).toContain("Failed to dismiss learning nudge")
    const status = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ capture: true, auto_reflect: true })
  }, 60_000)

  test("enable reports the home config that keeps capture off after writing project config", async () => {
    await using dir = await tmpdir({ git: true })
    const home = path.join(dir.path, "home")
    const override = path.join(home, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(override), { recursive: true })
    await fs.writeFile(override, JSON.stringify({ learn: { capture: false } }))
    const env = { OPENCODE_TEST_HOME: home }
    const result = await runLearn(dir.path, ["enable"], undefined, env)
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain("Project learning enabled")
    expect(result.stderr).toContain("learn.capture=false")
    expect(result.stderr).toContain(override)
    expect(result.stderr).toContain("learn.capture=true")
    expect(JSON.parse(await fs.readFile(path.join(dir.path, ".altimate-code", "altimate-code.json"), "utf8")))
      .toMatchObject({ learn: { capture: true, auto_reflect: true } })
    const status = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).capture).toBe(false)
  }, 60_000)

  test("enable overrides a lower-precedence global capture setting", async () => {
    await using dir = await tmpdir({ git: true })
    const configHome = path.join(dir.path, "global-config")
    const file = path.join(configHome, "altimate-code", "altimate-code.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const env = { XDG_CONFIG_HOME: configHome }
    // A non-default global value proves the global file is actually loaded.
    await fs.writeFile(file, JSON.stringify({ $schema: "https://altimate.ai/config.json", learn: { capture: true } }))
    const loaded = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(loaded.code).toBe(0)
    expect(JSON.parse(loaded.stdout).capture).toBe(true)
    const original = JSON.stringify({ $schema: "https://altimate.ai/config.json", learn: { capture: false } })
    await fs.writeFile(file, original)
    const before = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(before.code).toBe(0)
    expect(JSON.parse(before.stdout).capture).toBe(false)
    const result = await runLearn(dir.path, ["enable"], undefined, env)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Project learning enabled")
    const status = await runLearn(dir.path, ["status", "--json"], undefined, env)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).capture).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe(original)
  }, 60_000)

  test("enable reports an environment override that keeps capture off", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await runLearn(dir.path, ["enable"], undefined, { ALTIMATE_LEARN_CAPTURE: "0" })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain("Project learning enabled")
    expect(result.stderr).toContain("ALTIMATE_LEARN_CAPTURE=0")
    expect(result.stderr).toContain("ALTIMATE_LEARN_CAPTURE=1")
  }, 60_000)

  test.each(["OPENCODE_CONFIG_CONTENT", "ALTIMATE_CLI_CONFIG_CONTENT"])("enable names the inline override from %s", async (source) => {
    await using dir = await tmpdir({ git: true })
    const result = await runLearn(dir.path, ["enable"], undefined, { [source]: JSON.stringify({ learn: { capture: false } }) })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(`learn.capture=false is set in ${source}`)
    expect(result.stderr).toContain("Set learn.capture=true")
  }, 60_000)

  test("enable names the documented flag that disables project config", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await runLearn(dir.path, ["enable"], undefined, { ALTIMATE_CLI_DISABLE_PROJECT_CONFIG: "1" })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("disabled by ALTIMATE_CLI_DISABLE_PROJECT_CONFIG. Unset it")
  }, 60_000)

  test("status skips malformed history lines and retains the latest valid reflection", async () => {
    await using dir = await tmpdir({ git: true })
    const at = "2026-09-30T12:34:56.000Z"
    await Store.appendHistory(dir.path, Playbook.DEFAULT_NAME, {
      action: "reflect", ts: at, session: "ses_valid", applied: [], rejected: [],
    })
    await fs.appendFile(Store.paths(dir.path, Playbook.DEFAULT_NAME).history, 'not json\n'.repeat(20) + 'null\n{"action":"reflect"')
    const preload = path.join(dir.path, "history-warnings.ts")
    const logger = JSON.stringify(import.meta.resolve("../../../src/util/log"))
    await fs.writeFile(preload, `
import { spyOn } from "bun:test"
import { Log } from ${logger}
const create = Log.create.bind(Log)
spyOn(Log, "create").mockImplementation((tags) => {
  const logger = create(tags)
  if (tags?.service === "learn.cli") logger.warn = (message, extra) => {
    process.stderr.write("HISTORY_WARNING " + message + " " + JSON.stringify(extra) + "\\n")
  }
  return logger
})
`)
    for (const args of [["status"], ["status", "--json"]]) {
      const result = await runLearn(dir.path, args, preload)
      expect(result.code).toBe(0)
      expect(result.stderr.match(/HISTORY_WARNING/g)).toHaveLength(1)
      expect(result.stderr).toContain('"skipped":21')
      if (args.includes("--json")) {
        expect(JSON.parse(result.stdout).last_reflection).toMatchObject({ at, sessionID: "ses_valid", result: "success" })
      } else {
        expect(result.stdout).toContain(`Last reflection: ${at} - success`)
      }
    }
  }, 60_000)

  test("an interrupted config write preserves the original project settings", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.jsonc")
    const original = '// Keep these settings.\n{"learn":{"capture":false},"username":"analyst"}\n'
    await fs.writeFile(file, original, { mode: 0o600 })
    const preload = path.join(dir.path, "config-write-failure.ts")
    await fs.writeFile(preload, `
import fs from "node:fs/promises"
import { spyOn } from "bun:test"
const write = fs.writeFile.bind(fs)
const file = ${JSON.stringify(file)}
spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
  if (String(target) === file || String(target).startsWith(file + ".")) {
    await write(target, String(data).slice(0, 8), options)
    throw new Error("Interrupted project config write")
  }
  return write(target, data, options)
})
`)
    const result = await runLearn(dir.path, ["enable"], preload)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Interrupted project config write")
    expect(await fs.readFile(file, "utf8")).toBe(original)
    expect((await fs.readdir(dir.path)).filter((name) => name.startsWith("opencode.jsonc."))).toEqual([])
    expect((await learn(dir.path, "enable")).code).toBe(0)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  }, 60_000)

  test("enable and disable preserve a symlinked project config and update its shared target", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.jsonc")
    const target = path.join(dir.path, "shared", "config.jsonc")
    await fs.mkdir(path.dirname(target))
    await fs.writeFile(target, '// Shared settings.\n{"learn":{"capture":false,"auto_reflect":false}}\n')
    const link = path.relative(path.dirname(file), target)
    await fs.symlink(link, file)
    for (const [command, enabled] of [["enable", true], ["disable", false]] as const) {
      const result = await learn(dir.path, command)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`Project config: ${file}`)
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
      expect(await fs.readlink(file)).toBe(link)
      const text = await fs.readFile(target, "utf8")
      expect(text).toContain("// Shared settings.")
      expect(parseJsonc(text).learn).toEqual({ capture: enabled, auto_reflect: enabled })
      expect((await fs.readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }
  }, 60_000)

  test("enable and disable preserve config permissions under a restrictive umask", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ learn: { capture: false, auto_reflect: false } }))
    await fs.chmod(file, 0o664)
    const preload = path.join(dir.path, "restrictive-umask.ts")
    await fs.writeFile(preload, "process.umask(0o077)\n")
    for (const [command, enabled] of [["enable", true], ["disable", false]] as const) {
      const result = await runLearn(dir.path, [command], preload)
      expect(result.code).toBe(0)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o664)
      expect(parseJsonc(await fs.readFile(file, "utf8")).learn).toEqual({ capture: enabled, auto_reflect: enabled })
    }
  }, 60_000)

  test("nudge off and enable persist global dismissal even after disabling learning", async () => {
    await using dir = await tmpdir({ git: true })
    for (const command of [["nudge", "off"], ["enable"]]) {
      const state = path.join(dir.path, "state-" + command[0])
      const env = { OPENCODE_TEST_STATE_HOME: state }
      const result = await runLearn(dir.path, command, undefined, env)
      expect(result.code).toBe(0)
      expect(result.stderr).not.toContain("Error:")
      const file = path.join(state, "learn-nudge.json")
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
        shownProjectHashes: [], totalCount: 0, dismissed: true,
      })
      expect((await runLearn(dir.path, ["disable"], undefined, env)).code).toBe(0)
      expect(JSON.parse(await fs.readFile(file, "utf8")).dismissed).toBe(true)
      const status = await runLearn(dir.path, ["status", "--json"], undefined, env)
      expect(status.code).toBe(0)
      expect(JSON.parse(status.stdout).capture).toBe(false)
      expect(status.stdout).not.toContain("You corrected the agent")
    }
  }, 60_000)

  test("enable creates the project config and disable turns both flags off", async () => {
    await using dir = await tmpdir({ git: true })
    const enabled = await learn(dir.path, "enable")
    expect(enabled.code).toBe(0)
    const file = path.join(dir.path, ".altimate-code", "altimate-code.json")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      $schema: "https://altimate.ai/config.json", learn: { capture: true, auto_reflect: true },
    })
    expect(enabled.stdout).toContain("learn.capture=true, learn.auto_reflect=true")
    expect(enabled.stdout).toContain(file)
    expect(enabled.stdout).toContain(Store.paths(dir.path, Playbook.DEFAULT_NAME).learnDir)
    expect(enabled.stdout).not.toContain("learn bootstrap")
    expect(enabled.stdout).not.toContain("learn import-reviews")

    const disabled = await learn(dir.path, "disable")
    expect(disabled.code).toBe(0)
    expect(disabled.stdout).toContain("learn.capture=false, learn.auto_reflect=false")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ learn: { capture: false, auto_reflect: false } })
    expect(await Bun.file(path.join(dir.path, "config.json")).exists()).toBe(false)
  }, 60_000)

  test.each(["opencode.jsonc", ".opencode/opencode.jsonc", ".altimate-code/altimate-code.jsonc"])(
    "enable and disable preserve existing configuration and formatting in %s",
    async (relative) => {
      await using dir = await tmpdir({ git: true })
      const file = path.join(dir.path, relative)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const before = [
        "{",
        '\t"$schema": "https://altimate.ai/config.json",',
        "\t// Keep this project configuration.",
        '\t"username": "learner",',
        '\t"learn": {',
        '\t\t"model": "example/model",',
        '\t\t"max_stored": 32,',
        '\t\t"capture": false,',
        '\t\t"auto_reflect": false',
        "\t}",
        "}",
        "",
      ].join("\r\n")
      await fs.writeFile(file, before)
      const enabled = await learn(dir.path, "enable")
      expect(enabled.code).toBe(0)
      expect(enabled.stdout).toContain(file)
      const updated = await fs.readFile(file, "utf8")
      expect(updated).toBe(before.replace('"capture": false', '"capture": true').replace('"auto_reflect": false', '"auto_reflect": true'))
      expect(parseJsonc(updated)).toEqual({ $schema: "https://altimate.ai/config.json", username: "learner", learn: { model: "example/model", max_stored: 32, capture: true, auto_reflect: true } })
      expect((await learn(dir.path, "disable")).code).toBe(0)
      expect(await fs.readFile(file, "utf8")).toBe(before)
      expect(await Bun.file(path.join(dir.path, ".altimate-code", "altimate-code.json")).exists()).toBe(false)
    },
    60_000,
  )

  test("interactive enable prints bootstrap and review import commands without prompting", async () => {
    await using dir = await tmpdir({ git: true })
    const result = await learnWithConfirmation(dir.path, true, ["enable"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("altimate-code learn bootstrap")
    expect(result.stdout).toContain("altimate-code learn import-reviews")
    expect(result.stdout).not.toContain("not implemented yet")
    expect(result.stdout).not.toContain("CONFIRM:")
  }, 60_000)

  test.each([
    ["opencode.json", "opencode.jsonc"],
    [".altimate-code/altimate-code.json", ".altimate-code/opencode.json"],
    [".altimate-code/altimate-code.json", ".opencode/altimate-code.json"],
  ])("enable and disable update the effective config when %s and %s coexist", async (lower, higher) => {
    await using dir = await tmpdir({ git: true })
    const before = JSON.stringify({ $schema: "https://altimate.ai/config.json", learn: { capture: false, auto_reflect: false } }, null, 2)
    for (const relative of [lower, higher]) {
      await fs.mkdir(path.dirname(path.join(dir.path, relative)), { recursive: true })
      await fs.writeFile(path.join(dir.path, relative), before)
    }
    const enabled = await learn(dir.path, "enable")
    expect(enabled.code).toBe(0)
    expect(enabled.stdout).toContain(`Project config: ${path.join(dir.path, higher)}`)
    const on = await learn(dir.path, "status", "--json")
    expect(on.code).toBe(0)
    expect(JSON.parse(on.stdout)).toMatchObject({ capture: true, auto_reflect: true })
    expect(await fs.readFile(path.join(dir.path, lower), "utf8")).toBe(before)
    const disabled = await learn(dir.path, "disable")
    expect(disabled.code).toBe(0)
    expect(disabled.stdout).toContain(`Project config: ${path.join(dir.path, higher)}`)
    const off = await learn(dir.path, "status", "--json")
    expect(off.code).toBe(0)
    expect(JSON.parse(off.stdout)).toMatchObject({ capture: false, auto_reflect: false })
  }, 60_000)

  test("status defaults learning on with capture off, no reflection, counts and effective limits", async () => {
    await using dir = await tmpdir({ git: true })
    const shown = await learn(dir.path, "status")
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain("Learning enabled: yes")
    expect(shown.stdout).toContain("Capture: off; automatic reflection: off")
    expect(shown.stdout).toContain("Lessons: 0 approved, 0 candidate, 0 retired")
    expect(shown.stdout).toContain("Open signals: 0")
    expect(shown.stdout).toContain("Pending recoveries: 0")
    expect(shown.stdout).toContain("Last reflection: never")
    expect(shown.stdout).toContain("File hook: on")
    for (const limit of ["core_lessons=15", "retrieved_lessons=15", "request_lessons=5", "file_lessons=5", "budget_tokens=1500", "session_max_lessons=40", "max_stored=1000", "recovery_max_reflections=3", "recovery_max_seconds=300"])
      expect(shown.stdout).toContain(limit)
  }, 60_000)

  test("status includes stored lessons, open sessions, replacement recoveries and reflection history", async () => {
    await using dir = await tmpdir({ git: true })
    const name = "backend-rules"
    const first = { id: "L-0001", text: "Normalize timestamps using `normalize_utc`.", helpful: 1, harmful: 0 }
    const second = { id: "L-0002", text: "Convert currency using `currency_scale`.", helpful: 0, harmful: 0 }
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [first, second]))
    await Store.promote(dir.path, name)
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [first]), [
      { op: "REMOVE", id: second.id, reason: "outdated" },
    ])
    await Store.promote(dir.path, name)
    await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [first]))
    const at = "2026-09-30T12:34:56.000Z"
    await Store.appendHistory(dir.path, name, { action: "reflect", ts: at, session: "ses_old", applied: [], rejected: [] })
    await Signals.appendSignal(dir.path, { kind: "review", sessionID: "ses_old", text: "Check schema tests.", reason: "review" }, name)
    await Signals.appendSignal(dir.path, { kind: "review", sessionID: "ses_other", text: "Check uniqueness tests.", reason: "review" }, name)
    await fs.writeFile(Store.paths(dir.path, name).pendingReplacements, JSON.stringify({
      id: first.id, text: first.text, reasons: ["Convention changed."], feedback: "Use the approved macro.", kind: "review", attempts: 1,
    }) + "\n")
    await fs.writeFile(path.join(dir.path, "opencode.json"), JSON.stringify({ learn: {
      capture: true, auto_reflect: true, core_lessons: 7, retrieved_lessons: 6, budget_tokens: 500, session_max_lessons: 8,
      max_stored: 22, recovery_max_reflections: 1, recovery_max_seconds: 10,
    } }))

    const shown = await runLearn(dir.path, ["status", "--name", name, "--json"], undefined, { ALTIMATE_LEARN_MAX_STORED: "19" })
    expect(shown.code).toBe(0)
    expect(JSON.parse(shown.stdout)).toMatchObject({
      name, enabled: true, capture: true, auto_reflect: true, approved: 1, candidate: 1, retired: 1,
      open_signals: 2, pending_recoveries: 2, pending_replacements: 1, backoff_sessions: 0,
      last_reflection: { at, sessionID: "ses_old", result: "success", summary: "0 applied, 0 rejected" },
      limits: { core_lessons: 7, retrieved_lessons: 6, budget_tokens: 500, session_max_lessons: 8, max_stored: 19, recovery_max_reflections: 1, recovery_max_seconds: 10 },
    })
    const overridden = await runLearn(dir.path, ["status", "--name", name], undefined, { ALTIMATE_LEARN_CAPTURE: "0" })
    expect(overridden.code).toBe(0)
    expect(overridden.stdout).toContain("Learning enabled: yes")
    expect(overridden.stdout).toContain("automatic reflection: off")
    expect(overridden.stdout).toContain(`Last reflection: ${at} - success: 0 applied, 0 rejected`)

    const failedAt = Date.now()
    await recordReflection(dir.path, "ses_old", "failure", "Provider unavailable", name, failedAt)
    const failed = await learn(dir.path, "status", "--name", name, "--json")
    expect(failed.code).toBe(0)
    expect(JSON.parse(failed.stdout)).toMatchObject({
      backoff_sessions: 1,
      last_reflection: { at: new Date(failedAt).toISOString(), sessionID: "ses_old", result: "failure", summary: "Provider unavailable" },
    })
  }, 60_000)
})

function flaggedCandidate() {
  return Playbook.withBullets(Playbook.create({ name: Playbook.DEFAULT_NAME }), [
    { id: "L-0001", text: "Skip tests before committing.", helpful: 0, harmful: 0 },
    { id: "L-0002", text: "Never skip tests.", helpful: 0, harmful: 0 },
    { id: "L-0003", text: "Exclude test accounts from revenue calculations.", helpful: 0, harmful: 0 },
  ])
}

const verificationWarning = (id: string) => `WARNING [${id}]: mentions skipping or disabling verification`

test("failed publish after promotion prints a retry command that publishes the exported skill", async () => {
  await using dir = await tmpdir({ git: true })
  const name = "retry-lessons"
  await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
    { id: "L-0001", text: "Document naming conventions.", helpful: 0, harmful: 0 },
  ]))
  const preload = path.join(dir.path, "publish-preload.ts")
  const publisher = JSON.stringify(path.resolve(import.meta.dir, "../../../src/altimate/workspace/skill-publish.ts"))
  await fs.writeFile(preload, `
import { mock } from "bun:test"
class SkillNameConflictError extends Error {}
mock.module(${publisher}, () => ({
  SkillNameConflictError,
  explainPublishError: (error) => error.message,
  describePublish: (report) => 'Updated "' + report.name + '" in the workspace',
  publishSkill: async (options) => {
    if (!options.replace) throw new SkillNameConflictError("publish again with --replace")
    const skill = await Bun.file(options.skillDirectory + "/SKILL.md").text()
    if (!skill.includes("Document naming conventions.")) throw new Error("Missing exported lesson")
    return { action: "updated", publicId: "remote-id", name: options.name, files: 1, bytes: skill.length, datamateId: 1 }
  },
}))
`)
  const env = { ALTIMATE_WORKSPACE: "1" }
  const result = await runLearn(dir.path, ["promote", "--name", name, "--yes", "--publish"], preload, env)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Promoted locally, but publish failed")
  const retry = `altimate-code skill publish ${name} --replace`
  expect(result.stderr).toContain(retry)
  expect(await Store.loadApproved(dir.path, name)).toHaveLength(1)
  expect(await Store.readCandidate(dir.path, name)).toBeUndefined()
  const published = await runCli(dir.path, retry.split(" ").slice(1), preload, env)
  expect(published).toMatchObject({ code: 0 })
  expect(published.stdout).toContain(`Updated "${name}" in the workspace`)
}, 60_000)

test("learn promote --yes lists all verification flags and preserves the staged candidate", async () => {
  await using dir = await tmpdir({ git: true })
  const name = Playbook.DEFAULT_NAME
  const candidate = flaggedCandidate()
  await Store.saveCandidate(dir.path, name, candidate)

  const result = await learn(dir.path, "promote", "--yes")
  const output = result.stdout + result.stderr
  expect(result.code).not.toBe(0)
  expect(output).toContain("--allow-flagged")
  for (const bullet of Playbook.bullets(candidate).slice(0, 2)) {
    expect(output).toContain(verificationWarning(bullet.id))
    expect(output).toContain(bullet.text)
  }
  expect(output).not.toContain(verificationWarning("L-0003"))
  expect(await Store.readPromoted(dir.path, name)).toBeUndefined()
  expect(await Store.loadCandidateLessons(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
  expect(await Bun.file(Store.paths(dir.path, name).history).exists()).toBe(false)
}, 60_000)

test("learn show warns on staged and promoted bullets; --yes --allow-flagged promotes without persisted flags", async () => {
  await using dir = await tmpdir({ git: true })
  const name = Playbook.DEFAULT_NAME
  const candidate = flaggedCandidate()
  await Store.saveCandidate(dir.path, name, candidate)

  const staged = await learn(dir.path, "show")
  expect(staged.code).toBe(0)
  for (const bullet of Playbook.bullets(candidate).slice(0, 2)) {
    expect(staged.stdout).toContain(verificationWarning(bullet.id))
    expect(staged.stdout).toContain(bullet.text)
  }
  expect(staged.stdout).not.toContain(verificationWarning("L-0003"))

  const promoted = await learn(dir.path, "promote", "--yes", "--allow-flagged")
  expect(promoted.code).toBe(0)
  expect(promoted.stdout).toContain(`Promoted "${name}"`)
  expect(promoted.stdout).toContain(verificationWarning("L-0001"))
  expect(promoted.stdout).toContain(verificationWarning("L-0002"))
  expect(await Store.loadApproved(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
  expect(await Store.readCandidate(dir.path, name)).toBeUndefined()
  expect(await Store.readPromoted(dir.path, name)).not.toContain("f:verify")

  const shown = await learn(dir.path, "show")
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("# Candidate (none)")
  expect(shown.stdout).toContain(verificationWarning("L-0001"))
  expect(shown.stdout).toContain(verificationWarning("L-0002"))
  expect(shown.stdout).not.toContain(verificationWarning("L-0003"))
}, 60_000)

test.each([false, true])("interactive promote displays verification warnings before confirmation (confirmed=%s)", async (confirmed) => {
  await using dir = await tmpdir({ git: true })
  const name = Playbook.DEFAULT_NAME
  const candidate = flaggedCandidate()
  await Store.saveCandidate(dir.path, name, candidate)

  const result = await learnWithConfirmation(dir.path, confirmed)
  const prompt = "CONFIRM: Promote this candidate?"
  expect(result.stdout).toContain(prompt)
  for (const bullet of Playbook.bullets(candidate).slice(0, 2)) {
    expect(result.stdout).toContain(verificationWarning(bullet.id))
    expect(result.stdout.indexOf(verificationWarning(bullet.id))).toBeLessThan(result.stdout.indexOf(prompt))
    expect(result.stdout.indexOf(bullet.text)).toBeLessThan(result.stdout.indexOf(prompt))
  }
  expect(result.stdout).not.toContain(verificationWarning("L-0003"))
  if (!confirmed) {
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Cancelled.")
    expect(await Store.readPromoted(dir.path, name)).toBeUndefined()
    expect(await Store.loadCandidateLessons(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
    return
  }
  expect(result.code).toBe(0)
  expect(result.stdout.indexOf(prompt)).toBeLessThan(result.stdout.indexOf(`Promoted "${name}"`))
  expect(await Store.loadApproved(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
  expect(await Store.readCandidate(dir.path, name)).toBeUndefined()
}, 60_000)

test.each([false, true])("learn promote explains approval before review (yes=%s)", async (yes) => {
  await using dir = await tmpdir({ git: true })
  const name = Playbook.DEFAULT_NAME
  const candidate = Playbook.withBullets(Playbook.create({ name }), [
    { id: "L-0001", text: "Run unit tests before committing.", helpful: 0, harmful: 0 },
  ])
  await Store.saveCandidate(dir.path, name, candidate)

  const result = await learn(dir.path, "promote", ...(yes ? ["--yes"] : []))
  const notice = "Review the lessons below before making this candidate the approved set (and sharing it with your team if you publish)."
  const diff = "Run unit tests before committing."
  expect(result.stdout).toContain(notice)
  expect(result.stdout).toContain(diff)
  expect(result.stdout.indexOf(notice)).toBeLessThan(result.stdout.indexOf(diff))
  if (!yes) {
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Refusing to promote without confirmation")
    expect(await Store.readPromoted(dir.path, name)).toBeUndefined()
    expect(await Store.loadCandidateLessons(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
    return
  }
  expect(result.code).toBe(0)
  expect(result.stdout.indexOf(diff)).toBeLessThan(result.stdout.indexOf(`Promoted "${name}"`))
  expect(await Store.loadApproved(dir.path, name)).toMatchObject(Playbook.bullets(candidate))
  const history = (await fs.readFile(Store.paths(dir.path, name).history, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  expect(history).toHaveLength(1)
  expect(history[0]).toMatchObject({ action: "promote" })
  expect(history[0].published).toBeUndefined()
}, 60_000)

test("learn show displays pending recovery count", async () => {
  await using dir = await tmpdir({ git: true })
  const state = path.join(dir.path, ".altimate-code", "learn", "team-playbook")
  await fs.mkdir(state, { recursive: true })
  await fs.writeFile(path.join(state, "pending-replacements.jsonl"), JSON.stringify({
    id: "L-0001",
    text: "Convert `_cents` columns in staging.",
    reasons: ["The staging convention changed."],
    feedback: "Use the approved currency macro.",
    kind: "review",
    attempts: 1,
  }) + "\n")
  const shown = await learn(dir.path, "show")
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("Pending recoveries: 1")
  expect(shown.stdout).toContain("[L-0001] Convert `_cents` columns in staging. (attempts: 1)")
}, 60_000)

test("learn show marks migrated long lessons for shortening and displays approved and staged sets", async () => {
  await using dir = await tmpdir({ git: true })
  const name = "backend-rules"
  const text = "Use `normalize_event_time` before aggregation and preserve the original event timestamp in audit records to diagnose delayed arrivals and timezone conversions."
  expect(text.length).toBeGreaterThan(140)
  const paths = Store.paths(dir.path, name)
  await fs.mkdir(paths.skillDir, { recursive: true })
  await fs.writeFile(paths.skill, Playbook.serialize(Playbook.withBullets(Playbook.create({ name }), [
    { id: "L-0001", text, helpful: 4, harmful: 0 },
  ])))
  const shown = await learn(dir.path, "show", "--name", name)
  expect(shown.code).toBe(0)
  expect(shown.stdout).toContain("# Approved")
  expect(shown.stdout).toContain(text)
  expect(shown.stdout).toContain("long (shorten when next edited)")
  expect(shown.stdout).toContain("helpful: 4")
  expect(shown.stdout).toContain("# Candidate (none)")
  expect(await Bun.file(paths.approved).exists()).toBe(true)
}, 60_000)

test("learn search matches approved and retired lessons by case-insensitive tokens and excludes the candidate", async () => {
  await using dir = await tmpdir({ git: true })
  const name = "backend-rules"
  const old = { id: "L-0001", text: "Convert currency with `currency_scale`.", helpful: 0, harmful: 0 }
  const current = { id: "L-0002", text: "Normalize timestamps using `normalize_utc`.", helpful: 1, harmful: 0 }
  const staged = { id: "L-0003", text: "Validate timestamps using `validate_time`.", helpful: 0, harmful: 0 }
  await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [old, current]))
  await Store.promote(dir.path, name)
  await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [current]), [
    { op: "REMOVE", id: old.id, reason: "outdated" },
  ])
  const pending = await learn(dir.path, "search", "currency", "--name", name)
  expect(pending.stdout).toContain(`[${old.id}] approved: ${old.text}`)
  expect(pending.stdout).not.toContain(`[${old.id}] retired:`)
  await Store.promote(dir.path, name)
  await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [current, staged]))

  const approved = await learn(dir.path, "search", "TIMESTAMPS normalize_utc", "--name", name)
  expect(approved.code).toBe(0)
  expect(approved.stdout).toContain(`[${current.id}] approved: ${current.text}`)
  const retired = await learn(dir.path, "search", "CURRENCY", "--name", name)
  expect(retired.code).toBe(0)
  expect(retired.stdout).toContain(`[${old.id}] retired: ${old.text}`)
  expect((await learn(dir.path, "search", "validate_time", "--name", name)).stdout).toContain("No matching lessons.")
  expect((await learn(dir.path, "search", "currency nonexistent", "--name", name)).stdout).toContain("No matching lessons.")
}, 60_000)

test("learn.max_stored loads from project config and invalid values fail before reflection", async () => {
  await using dir = await tmpdir({ git: true })
  const config = path.join(dir.path, "opencode.json")
  await fs.writeFile(config, JSON.stringify({ learn: { max_stored: 12 } }))
  const accepted = await learn(dir.path, "reflect", "--pending")
  expect(accepted.code).toBe(0)
  expect(accepted.stdout).toContain("nothing to learn")
  await fs.writeFile(config, JSON.stringify({ learn: { max_stored: 0 } }))
  const rejected = await learn(dir.path, "reflect", "--pending")
  expect(rejected.code).not.toBe(0)
  expect(rejected.stdout + rejected.stderr).toContain("max_stored")
}, 60_000)

test("learn promote --publish exports the approved set before invoking workspace publishing", async () => {
  await using dir = await tmpdir({ git: true })
  const name = "backend-rules"
  const text = "Normalize timestamps using `normalize_utc`."
  await Store.saveCandidate(dir.path, name, Playbook.withBullets(Playbook.create({ name }), [
    { id: "L-0001", text, helpful: 2, harmful: 0 },
  ]))
  const preload = path.join(dir.path, "learn-publish.ts")
  const publisher = JSON.stringify(import.meta.resolve("../../../src/altimate/workspace/skill-publish"))
  await fs.writeFile(preload, `
import { mock } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
mock.module(${publisher}, () => ({
  publishSkill: async ({ skillDirectory }) => {
    const skill = await fs.readFile(path.join(skillDirectory, "SKILL.md"), "utf8")
    if (!skill.includes(${JSON.stringify(Playbook.HEADER)}) || !skill.includes(${JSON.stringify(text)}))
      throw new Error("approved lessons were not exported before publishing")
    return {}
  },
  describePublish: () => "Published approved lessons.",
  explainPublishError: () => undefined,
}))
`)
  const result = await runLearn(dir.path, ["promote", "--yes", "--publish", "--name", name], preload, { ALTIMATE_WORKSPACE: "1" })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("Published approved lessons.")
  expect(await Store.readCandidate(dir.path, name)).toBeUndefined()
  expect(await fs.readFile(Store.paths(dir.path, name).skill, "utf8")).toContain(Playbook.HEADER)
}, 60_000)

describe("learn signal add / signals", () => {
  test("--name keeps integration signals and pending reflection scoped to their store", async () => {
    await using dir = await tmpdir({ git: true })
    const name = "backend-rules"
    const added = await learn(dir.path, "signal", "add", "--kind", "review", "--text", "Use explicit columns.", "--name", name)
    expect(added.code).toBe(0)
    expect(await Signals.readSignals(dir.path)).toEqual([])
    expect(await Signals.readSignals(dir.path, name)).toHaveLength(1)
    const listed = await learn(dir.path, "signals", "--name", name, "--json")
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)[0].text).toBe("Use explicit columns.")
    expect((await learn(dir.path, "reflect", "--pending")).stdout).toContain("nothing to learn")
  }, 60_000)

  test("add redacts credentials mentioned in a user correction before writing JSONL", async () => {
    await using dir = await tmpdir()
    const text = "No: connect with sqlcmd -S prod -U sa -P hunter2 and email ops@acme.com before changing staging models."
    const added = await learn(dir.path, "signal", "add", "--kind", "user", "--text", text)
    expect(added.code).toBe(0)
    const raw = await fs.readFile(Signals.signalsFile(dir.path), "utf8")
    expect(raw).not.toContain("hunter2")
    expect(raw).not.toContain("ops@acme.com")
    expect(JSON.parse(raw).text).toBe(
      "No: connect with sqlcmd -S prod -U sa -P [REDACTED] and email [REDACTED] before changing staging models.",
    )
  }, 60_000)

  test("add records a review signal, signals lists it, --json and --all work, a repeat is deduped", async () => {
    await using dir = await tmpdir({ git: true })
    const added = await learn(dir.path, "signal", "add", "--kind", "review", "--text", "Reviewer: add a unique test on order_id")
    expect(added.code).toBe(0)
    expect(added.stdout).toContain("Recorded sig_")

    const stored = await Signals.readSignals(dir.path)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ kind: "review", sessionID: "external", status: "open" })
    expect(stored[0].text).toContain("unique test on order_id")

    const again = await learn(dir.path, "signal", "add", "--kind", "review", "--text", "Reviewer: add a unique test on order_id")
    expect(again.stdout).toContain("Already recorded")

    const list = await learn(dir.path, "signals")
    expect(list.stdout).toContain("review")
    expect(list.stdout).toContain("unique test on order_id")

    const json = JSON.parse((await learn(dir.path, "signals", "--json")).stdout)
    expect(json).toHaveLength(1)

    await Signals.consumeSignals(dir.path, [stored[0].id], "reflect@x")
    expect((await learn(dir.path, "signals")).stdout).toContain("No open learning signals")
    expect((await learn(dir.path, "signals", "--all")).stdout).toContain("consumed(reflect@x)")
  }, 60_000)

  test("add --file with --kind user and a session; secrets are redacted", async () => {
    await using dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "ci.log")
    await fs.writeFile(file, "FAILED dbt test\nkey sk-abcdef1234567890XYZ\n")
    const r = await learn(dir.path, "signal", "add", "--kind", "user", "--file", file, "--session", "ses_abc")
    expect(r.code).toBe(0)
    const [s] = await Signals.readSignals(dir.path)
    expect(s).toMatchObject({ kind: "user_correction", sessionID: "ses_abc" })
    expect(s.text).toContain("FAILED dbt test")
    expect(s.text).not.toContain("sk-abcdef1234567890XYZ")
  }, 60_000)

  test("add needs exactly one of --text / --file and a valid kind", async () => {
    await using dir = await tmpdir({ git: true })
    expect((await learn(dir.path, "signal", "add", "--kind", "ci")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "ci", "--text", "a", "--file", "b")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "bogus", "--text", "a")).code).not.toBe(0)
    expect((await learn(dir.path, "signal", "add", "--kind", "ci", "--file", "/nonexistent/x.log")).code).not.toBe(0)
    expect(await Signals.readSignals(dir.path)).toEqual([])
  }, 60_000)

  test("reflect with no open signals says so and exits 0, for --session and --pending", async () => {
    await using dir = await tmpdir({ git: true })
    const one = await learn(dir.path, "reflect", "--session", "ses_none")
    expect(one.code).toBe(0)
    expect(one.stdout).toContain("nothing to learn")
    const all = await learn(dir.path, "reflect", "--pending")
    expect(all.code).toBe(0)
    expect(all.stdout).toContain("nothing to learn")
  }, 60_000)

  test("reflect --pending cannot be combined with --feedback", async () => {
    await using dir = await tmpdir({ git: true })
    const r = await learn(dir.path, "reflect", "--pending", "--feedback", "x.log")
    expect(r.code).not.toBe(0)
  }, 60_000)
})
