/**
 * Opt-in, real-model smoke tests: scripts/analyst-smoke.sh
 * Ordinary `bun test` skips these tests and spends no subscription quota.
 * Each CLI scenario runs once; 7/8 inspect scenario 1's recorded run. There are
 * no retries. ANALYST_SMOKE_REPLAY=/path/to/artifacts rechecks saved evidence
 * without invoking the CLI or model. Never change an assertion to hide a
 * product failure. Logs, output, traces and synthetic databases are retained.
 *
 * SKIPs: not opted in; missing DuckDB binding (2b); missing SQL deadline (3).
 * Missing auth, startup errors and scenario timeouts are FAILs, not SKIPs.
 * Source mode has no embedded skill bundle: copy the actual repository skill
 * into each isolated project. This tests skill loading, not compiled packaging.
 */
import { afterAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertFinalOutput } from "./output-assertions"
import { createFixtures, SLOW_SQL, verifySlowQuery } from "./fixtures"

const ROOT = path.resolve(import.meta.dir, "../../../..")
const MODEL = "openai/gpt-5.6-sol"
const TIMEOUT_MS = 300_000
const QUERY_TIMEOUT_MS = 15_000
const enabled = process.env.ANALYST_SMOKE_RUN === "1" || !!process.env.ANALYST_SMOKE_REPLAY
const replay = process.env.ANALYST_SMOKE_REPLAY
const artifacts = path.resolve(
  replay || process.env.ANALYST_SMOKE_ARTIFACTS || path.join(os.tmpdir(), `analyst-smoke-${process.pid}`),
)
// The wrapper captures this before the package test preload replaces XDG vars.
const authFile = process.env.ANALYST_SMOKE_AUTH_FILE || path.join(os.homedir(), ".local/share/altimate-code/auth.json")
const skillSource = path.join(ROOT, ".opencode/skills/data-question/SKILL.md")
const crossPrompt =
  "What is the average temperature across all readings from sensors in region 'north'? " +
  "Use sensors_db.sensor and readings_db.reading. Inspect and reconcile their sensor identifier formats. " +
  "Compute from raw readings, and end with **Answer:** followed by the numeric average with at least 10 decimal places."

type Json = Record<string, any>
type Outcome = {
  id: string
  directory: string
  pid: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  remainingProcesses: string[]
  processInspectionError?: string
  sensorsBefore: string
  sensorsAfter: string
}
type Run = Outcome & { events: Json[]; output: string; log: string; traces: Json[]; stdout: string }
type Result = { id: string; name: string; status: "PASS" | "FAIL" | "SKIP"; reason?: string; directory?: string }
type FixtureInfo = Awaited<ReturnType<typeof createFixtures>> & { deadlineAvailable: boolean; slowVerifiedMs?: number }
const results: Result[] = []
const runs = new Map<string, Promise<Run>>()
let fixturesPromise: Promise<FixtureInfo> | undefined

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n")
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function hash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
}

async function fixtures(): Promise<FixtureInfo> {
  return (fixturesPromise ??= (async () => {
    if (replay) return readJson(path.join(artifacts, "fixtures.json"))
    await fs.mkdir(artifacts, { recursive: true, mode: 0o700 })
    const saved = path.join(artifacts, "fixtures.json")
    if (await Bun.file(saved).exists()) return readJson(saved)
    const fixtureDir = path.join(artifacts, "fixtures")
    await fs.mkdir(fixtureDir, { recursive: true })
    const info = await createFixtures(fixtureDir)
    const policy = await fs.readFile(path.join(ROOT, "packages/drivers/src/query-timeout.ts"), "utf8").catch(() => "")
    const sqlite = await fs.readFile(path.join(ROOT, "packages/drivers/src/sqlite.ts"), "utf8")
    const manifest: FixtureInfo = {
      ...info,
      deadlineAvailable: policy.includes("ALTIMATE_SQL_QUERY_TIMEOUT_MS") && sqlite.includes("resolveQueryTimeout"),
    }
    await writeJson(path.join(artifacts, "fixtures.json"), manifest)
    return manifest
  })())
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  // An allowlist avoids inheriting test mocks, model paths, provider keys, MCP
  // configuration, and the package preload's global database into the CLI.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return {
    ...env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "share"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CONFIG_DIRS: path.join(home, "config-dirs"),
    XDG_DATA_DIRS: path.join(home, "data-dirs"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_STATE_HOME: path.join(home, "state"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
    OPENCODE_PURE: "1",
    ALTIMATE_TELEMETRY_DISABLED: "true",
    ALTIMATE_DISABLE_WORKSPACE: "1",
    ALTIMATE_CODE_DISABLE_OS_CREDENTIAL_STORE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
}

async function processGroup(pid: number): Promise<string[]> {
  // The CLI is a session/process-group leader; LocalEngine's Bun helpers inherit
  // this group (their spawn does not detach). kill(0) probes every remaining
  // member, including reparented orphans, without needing sandbox-blocked ps.
  try {
    process.kill(-pid, 0)
    return [`process group ${pid} still has a live CLI descendant`]
  } catch (error: any) {
    if (error.code === "ESRCH") return []
    throw error
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error: any) {
    if (error.code !== "ESRCH") throw error
  }
}

async function launch(args: string[], directory: string, env: NodeJS.ProcessEnv, timeoutMs = TIMEOUT_MS) {
  const out = openSync(path.join(directory, "events.jsonl"), "w", 0o600)
  const err = openSync(path.join(directory, "cli.log"), "w", 0o600)
  const started = Date.now()
  const child = spawn(
    process.execPath,
    ["run", "--no-env-file", "--conditions=browser", "packages/opencode/src/index.ts", ...args],
    {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", out, err],
    },
  )
  closeSync(out)
  closeSync(err)
  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    if (!child.pid) return
    killGroup(child.pid, "SIGTERM")
    hardKill = setTimeout(() => killGroup(child.pid!, "SIGKILL"), 1500)
  }, timeoutMs)
  let exited: { exitCode: number | null; signal: string | null }
  try {
    exited = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
    })
  } finally {
    clearTimeout(timer)
    if (hardKill) clearTimeout(hardKill)
  }
  const pid = child.pid!
  let remainingProcesses: string[] = []
  let processInspectionError: string | undefined
  try {
    const until = Date.now() + 2000
    do {
      remainingProcesses = await processGroup(pid)
      if (!remainingProcesses.length) break
      await Bun.sleep(50)
    } while (Date.now() < until)
  } catch (error) {
    processInspectionError = String(error)
  } finally {
    // Capture leaks before cleaning up, so cleanup cannot turn a failure green.
    killGroup(pid, "SIGKILL")
  }
  return { pid, ...exited, timedOut, elapsedMs: Date.now() - started, remainingProcesses, processInspectionError }
}

async function loadRun(id: string): Promise<Run> {
  const directory = path.join(artifacts, id)
  const outcome: Outcome = await readJson(path.join(directory, "run.json"))
  const stdout = await fs.readFile(path.join(directory, "events.jsonl"), "utf8")
  const log = await fs.readFile(path.join(directory, "cli.log"), "utf8")
  const output = await fs.readFile(path.join(directory, "output.md"), "utf8").catch(() => "")
  // Keep diagnostics available for assertion failures even when startup emitted
  // non-JSON text. common() explicitly rejects malformed event streams.
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  const traces = []
  for (const file of await fs.readdir(path.join(directory, "traces")).catch(() => [])) {
    if (file.endsWith(".json")) traces.push(await readJson(path.join(directory, "traces", file)))
  }
  return { ...outcome, directory, stdout, log, output, events, traces }
}

function run(id: string, prompt: string, turns = 12, extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  const cached = runs.get(id)
  if (cached) return cached
  const promise = (async () => {
    if (replay) return loadRun(id)
    const fixture = await fixtures()
    const directory = path.join(artifacts, id)
    await fs.mkdir(directory, { recursive: true })
    // Fail closed when a caller reuses an artifact directory; never spend quota
    // twice accidentally. Use replay for fixing test bugs against this evidence.
    await fs.writeFile(path.join(directory, "started.json"), JSON.stringify({ prompt, turns, model: MODEL }), {
      flag: "wx",
    })
    const project = path.join(directory, "project")
    const home = path.join(directory, "home")
    const traces = path.join(directory, "traces")
    const authDestination = path.join(home, "share/altimate-code/auth.json")
    await fs.mkdir(path.join(project, ".altimate-code"), { recursive: true })
    await fs.mkdir(path.join(home, "share/altimate-code"), { recursive: true, mode: 0o700 })
    await fs.mkdir(traces, { recursive: true })
    const sensors = path.join(project, "sensors.db")
    const readings = path.join(project, "readings.db")
    await fs.copyFile(fixture.sensors, sensors)
    await fs.copyFile(fixture.readings, readings)
    const connections: Json = {
      sensors_db: { type: "sqlite", path: sensors, readonly: true },
      readings_db: { type: "sqlite", path: readings, readonly: true },
    }
    if (fixture.wide) {
      const wide = path.join(project, "wide.duckdb")
      await fs.copyFile(fixture.wide, wide)
      connections.wide_db = { type: "duckdb", path: wide, readonly: true }
    }
    await writeJson(path.join(project, ".altimate-code/connections.json"), connections)
    await fs.mkdir(path.join(project, ".opencode/skills/data-question"), { recursive: true })
    await fs.copyFile(skillSource, path.join(project, ".opencode/skills/data-question/SKILL.md"))
    await writeJson(path.join(project, "opencode.json"), {
      model: MODEL,
      enabled_providers: ["openai"],
      // The committed dev model snapshot predates this subscription model.
      provider: {
        openai: { models: { "gpt-5.6-sol": { name: "GPT-5.6 Sol", limit: { context: 400000, output: 32768 } } } },
      },
      experimental: { auto_mcp_discovery: false },
      tracing: { enabled: true, dir: traces, maxFiles: 0 },
      share: "disabled",
    })
    const sensorsBefore = await hash(sensors)
    try {
      // Copy only the existing subscription entry, never print it, and remove
      // the isolated copy in finally. Other provider credentials stay outside.
      const auth = await readJson(authFile)
      if (auth.openai?.type !== "oauth")
        throw new Error("OpenAI subscription OAuth is missing from ANALYST_SMOKE_AUTH_FILE")
      await fs.writeFile(authDestination, JSON.stringify({ openai: auth.openai }), { mode: 0o600 })
      const args = [
        "run",
        "--dir",
        project,
        "--model",
        MODEL,
        "--yolo",
        "--agent",
        "analyst",
        "--max-turns",
        String(turns),
        "--output",
        path.join(directory, "output.md"),
        "--format",
        "json",
        "--print-logs",
        "--log-level",
        "INFO",
        "--trace",
        prompt,
      ]
      await writeJson(path.join(directory, "command.json"), { cwd: ROOT, executable: process.execPath, args, home })
      const execution = await launch(args, directory, { ...childEnvironment(home), ...extraEnv })
      await writeJson(path.join(directory, "run.json"), {
        id,
        directory,
        ...execution,
        sensorsBefore,
        sensorsAfter: await hash(sensors),
      })
      return loadRun(id)
    } finally {
      await fs.rm(authDestination, { force: true })
    }
  })()
  runs.set(id, promise)
  return promise
}

function tools(run: Run, name: string): Json[] {
  return run.events.filter((event) => event.type === "tool_use" && event.part?.tool === name).map((event) => event.part)
}

function rootTrace(run: Run): Json {
  const saved = run.events.find((event) => event.type === "trace_saved")
  expect(saved, "JSON stream must name the trace artifact").toBeDefined()
  const root = run.traces.find((trace) => trace.sessionId === saved!.sessionID)
  expect(root, "Root trace must exist and match the JSON session").toBeDefined()
  expect(path.resolve(saved!.path)).toBe(path.join(run.directory, "traces", `${root!.sessionId}.json`))
  return root!
}

function common(run: Run, expectedExit = 0) {
  expect(run.timedOut, `CLI exceeded ${TIMEOUT_MS}ms; log: ${run.directory}/cli.log`).toBe(false)
  expect(run.signal, "CLI must exit normally").toBeNull()
  expect(run.exitCode, `CLI exit status; log: ${run.directory}/cli.log`).toBe(expectedExit)
  expect(run.processInspectionError).toBeUndefined()
  expect(run.remainingProcesses, "CLI children remained alive after exit (recorded before forced cleanup)").toEqual([])
  expect(run.stdout.trim().length, "JSON event stream is empty").toBeGreaterThan(0)
  for (const line of run.stdout.trim().split("\n"))
    expect(() => JSON.parse(line), `Non-JSON stdout: ${line.slice(0, 300)}`).not.toThrow()
  expect(run.events.some((event) => event.type === "termination")).toBe(true)
  expect(run.log.trim().length, "--print-logs must capture the INFO log").toBeGreaterThan(0)
  expect(run.log).not.toMatch(/Discovering MCP servers|mcp stderr/i)
  expect(run.output.trim().length, "--output must contain a response").toBeGreaterThan(0)
  expect(run.output).not.toMatch(/\(no text output[^\n]*tool-only response\)/i)
  assertFinalOutput(run.events, run.output)
  const trace = rootTrace(run)
  expect(trace.spans.length).toBeGreaterThan(0)
  expect(trace.metadata.agent).toBe("analyst")
  expect(trace.metadata.model).toBe(MODEL)
}

function answer(run: Run, expected: number) {
  const lines = [...run.output.matchAll(/^\*\*Answer:\*\*\s*(.+)$/gm)]
  expect(lines.length, "Expected a final **Answer:** line in --output").toBeGreaterThan(0)
  // The answer can quote earlier results; grade only the final
  // declared answer, never an alternate number elsewhere in the transcript.
  const match = lines.at(-1)![1].match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i)
  expect(match, "Answer line must contain the computed numeric average").not.toBeNull()
  const actual = Number(match![0])
  expect(Math.abs(actual - expected), `Expected ${expected}, observed ${actual}; tolerance 1e-6`).toBeLessThanOrEqual(
    1e-6,
  )
}

async function assertSpill(run: Run, wide = false) {
  const part = tools(run, "sql_execute").find(
    (part) =>
      part.state.input.warehouse === (wide ? "wide_db" : "readings_db") &&
      /^\s*SELECT\s+\*/i.test(part.state.input.query),
  )
  expect(part, "Expected SELECT * sql_execute call").toBeDefined()
  const { output, metadata, status } = part!.state
  expect(status).toBe("completed")
  expect(output.startsWith("Preview:")).toBe(true)
  expect(metadata.output_truncated).toBe(true)
  expect(metadata.row_limited).toBe(!wide)
  expect(typeof metadata.result_path).toBe("string")
  expect(output).toContain(metadata.result_path)
  expect(metadata.rows_returned).toBeGreaterThan(0)
  expect(metadata.rows_returned).toBeLessThanOrEqual(wide ? 1 : 10_000)
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024)
  const real = await fs.realpath(metadata.result_path)
  expect(
    real.startsWith((await fs.realpath(run.directory)) + path.sep),
    "Spill must remain inside the isolated run",
  ).toBe(true)
  const rows = (await fs.readFile(real, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(rows).toHaveLength(metadata.rows_returned)
  for (const row of rows) {
    expect(row.columns).toEqual(wide ? ["payload"] : ["sid", "temp"])
    expect(row.values).toHaveLength(wide ? 1 : 2)
  }
  if (wide) {
    expect(output).toMatch(/cell clipped/)
    expect(rows[0].values[0]).toBe("w".repeat(100 * 1024))
  } else {
    expect(metadata.rows_returned).toBeLessThan(200_000)
    expect(metadata.preview_rows).toBeLessThan(metadata.rows_returned)
  }
  expect(rootTrace(run).spans.some((span: Json) => span.kind === "tool" && span.name === "sql_execute")).toBe(true)
  // Reading the spill is optional. If attempted, it must succeed.
  for (const read of tools(run, "read")) {
    if (read.state.input.filePath === metadata.result_path) expect(read.state.status).toBe("completed")
  }
}

async function saveResults() {
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 })
  await writeJson(path.join(artifacts, "results.json"), results)
}

function logExcerpt(log: string) {
  // Provider errors can include an entire tool catalogue on one line. Keep the
  // terminal excerpt useful; failure-<id>.txt and cli.log retain the full log.
  const errors = log.split("\n").filter((line) => /\[ERROR\]|\[WARN\]|^error:|^Error:/.test(line))
  return errors.length
    ? errors
        .slice(-6)
        .map((line) => line.slice(0, 800))
        .join("\n")
    : log.slice(-3000)
}

function scenario(id: string, name: string, check: () => Promise<void>, skip?: () => Promise<string | undefined>) {
  if (!enabled) {
    test.skip(`${id} ${name} [opt in with scripts/analyst-smoke.sh]`, () => {})
    return
  }
  test(
    `${id} ${name}`,
    async () => {
      const directory = path.join(artifacts, id === "7" || id === "8" ? "1" : id)
      try {
        const reason = await skip?.()
        if (reason) {
          results.push({ id, name, status: "SKIP", reason })
          console.log(`SKIP ${id} ${name}: ${reason}`)
          return
        }
        await check()
        results.push({ id, name, status: "PASS", directory })
      } catch (error: any) {
        const reason = error?.message || String(error)
        results.push({ id, name, status: "FAIL", reason, directory })
        const log = await fs.readFile(path.join(directory, "cli.log"), "utf8").catch(() => "(CLI did not reach launch)")
        await fs.writeFile(path.join(artifacts, `failure-${id}.txt`), `${reason}\n\nLog: ${directory}/cli.log\n${log}`)
        throw new Error(`${reason}\nArtifacts: ${directory}\nLog excerpt:\n${logExcerpt(log)}`, { cause: error })
      } finally {
        await saveResults()
      }
    },
    TIMEOUT_MS + 45_000,
  )
}

scenario("0", "fixture/source preflight (no model calls)", async () => {
  const info = await fixtures()
  expect(Number.isFinite(info.expectedAverage)).toBe(true)
  expect(info.northReadings).toBeGreaterThan(0)
  const directory = path.join(artifacts, "0")
  const file = path.join(directory, "preflight.json")
  if (!replay && !(await Bun.file(file).exists())) {
    await fs.mkdir(directory, { recursive: true })
    const [help, slow] = await Promise.all([
      launch(["run", "--help"], directory, childEnvironment(path.join(directory, "home")), 45_000),
      info.deadlineAvailable && !info.slowVerifiedMs ? verifySlowQuery(directory) : Promise.resolve(undefined),
    ])
    await writeJson(file, help)
    if (slow) {
      info.slowVerifiedMs = slow.verifiedMs
      await writeJson(path.join(artifacts, "fixtures.json"), info)
    }
  }
  if (info.deadlineAvailable) expect(info.slowVerifiedMs).toBeGreaterThan(120_000)
  const help = await readJson(file)
  expect(help.timedOut).toBe(false)
  expect(help.exitCode).toBe(0)
  expect(help.processInspectionError).toBeUndefined()
  expect(help.remainingProcesses).toEqual([])
  const output =
    (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")) +
    (await fs.readFile(path.join(directory, "cli.log"), "utf8"))
  for (const flag of ["--agent", "--max-turns", "--format", "--output"]) expect(output).toContain(flag)
})

scenario("1", "cross-engine answer", async () => {
  const result = await run("1", crossPrompt, 18)
  common(result)
  answer(result, (await fixtures()).expectedAverage)
  expect(tools(result, "sql_execute").length).toBeGreaterThan(0)
  expect(rootTrace(result).spans.some((span: Json) => span.kind === "tool" && span.name === "sql_execute")).toBe(true)
})

scenario("2", "truncation envelope, spill and optional read", async () => {
  const result = await run(
    "2",
    "List every reading row from readings_db.reading. First execute SELECT * FROM reading using sql_execute with limit 10000. Report the preview's returned-row count and result_path; do not paginate or claim the preview is complete. You may read the first few lines of the spill. End with a concise answer.",
    6,
  )
  common(result)
  await assertSpill(result)
})

scenario(
  "2b",
  "wide DuckDB cell byte clipping",
  async () => {
    const result = await run(
      "2b",
      "Execute SELECT * FROM wide on wide_db using sql_execute. Report whether the text cell was clipped and provide the result_path. Do not print the full cell or repeat the query.",
      4,
    )
    common(result)
    await assertSpill(result, true)
  },
  async () => (await fixtures()).wideSkip,
)

scenario(
  "3",
  "SQL cancellation, next query and child cleanup",
  async () => {
    const info = await fixtures()
    expect(
      info.slowVerifiedMs,
      "Preflight must prove this query runs for more than two minutes without a deadline",
    ).toBeGreaterThan(120_000)
    const result = await run(
      "3",
      `Run exactly this SQL and report the error or result: ${SLOW_SQL};\nUse sensors_db. After it returns an error or result, run SELECT 1 AS ok on sensors_db in the same session to confirm the connection still works. Do not rewrite the first SQL or retry it. Do not pass query_timeout_ms to sql_execute: the deadline under test comes from the environment, and a per-call value overrides it.`,
      6,
      { ALTIMATE_SQL_QUERY_TIMEOUT_MS: String(QUERY_TIMEOUT_MS) },
    )
    common(result)
    const calls = tools(result, "sql_execute")
    const slow = calls.find((part) => part.state.input.query.trim().replace(/;$/, "") === SLOW_SQL)
    expect(slow, "Agent must execute the exact slow query").toBeDefined()
    expect(JSON.stringify(slow!.state)).toMatch(/QUERY_TIMEOUT|execution deadline|timed? out/i)
    const duration = slow!.state.time.end - slow!.state.time.start
    // The model may legitimately pass its own per-call deadline, which outranks the
    // environment value; whichever applied, the query must stop close to it and far
    // below the 120 s default.
    const perCall = slow!.state.input.query_timeout_ms
    const applied = typeof perCall === "number" && perCall > 0 ? perCall : QUERY_TIMEOUT_MS
    expect(applied, "the applied deadline must be a short one, not the 120 s default").toBeLessThan(60_000)
    expect(duration).toBeGreaterThanOrEqual(applied - 500)
    expect(duration, `Timeout must return close to the applied ${applied} ms deadline`).toBeLessThan(applied + 5000)
    const next = calls.find(
      (part) => /SELECT\s+1\s+AS\s+ok/i.test(part.state.input.query) && part.state.time.start >= slow!.state.time.end,
    )
    expect(next, "A subsequent fast query must execute after cancellation").toBeDefined()
    expect(next!.state.input.warehouse).toBe("sensors_db")
    expect(next!.state.status).toBe("completed")
    expect(next!.state.metadata.error).toBeUndefined()
    expect(next!.state.output).toMatch(/\bok\b[\s\S]*\b1\b/)
    expect(result.output).toMatch(/timeout|timed out|deadline|cancel/i)
  },
  async () =>
    (await fixtures()).deadlineAvailable
      ? undefined
      : "ALTIMATE_SQL_QUERY_TIMEOUT_MS is absent from the SQLite driver in this tree",
)

scenario("4", "data-explorer child SQL trace bundle", async () => {
  const result = await run(
    "4",
    "Use the task tool to delegate this sub-question to the data-explorer subagent: execute SELECT COUNT(*) AS sensor_count FROM sensor on sensors_db with sql_execute and report the count. Wait for its result, then answer with the count. The subagent must query the database itself.",
    8,
  )
  common(result)
  const task = tools(result, "task").find((part) => part.state.input.subagent_type === "data-explorer")
  expect(task, "Expected delegation to data-explorer").toBeDefined()
  expect(task!.state.status).toBe("completed")
  const childId = task!.state.metadata.sessionId
  expect(typeof childId).toBe("string")
  const root = rootTrace(result)
  expect(
    root.metadata.run.sessions.some(
      (session: Json) => session.sessionId === childId && session.parentSessionId === root.sessionId,
    ),
  ).toBe(true)
  const child = result.traces.find((trace) => trace.sessionId === childId)
  expect(child, "Trace bundle must include the actual child session").toBeDefined()
  expect(child!.metadata.run.parentSessionId).toBe(root.sessionId)
  expect(
    child!.spans.some(
      (span: Json) => span.kind === "tool" && span.name === "sql_execute" && span.attributes.sessionId === childId,
    ),
  ).toBe(true)
  expect(result.output).toMatch(/\b300\b/)
})

scenario("5", "data-question skill body loads", async () => {
  const result = await run(
    "5",
    "Use the data-question skill, then answer: How many sensors are in sensors_db.sensor? Load the skill using the skill tool before querying.",
    8,
  )
  common(result)
  const skill = tools(result, "skill").find((part) => part.state.input.name === "data-question")
  expect(skill, "Expected skill tool invocation for data-question").toBeDefined()
  expect(skill!.state.status).toBe("completed")
  expect(skill!.state.output).toContain('<skill_content name="data-question">')
  const body = (
    await fs.readFile(path.join(result.directory, "project/.opencode/skills/data-question/SKILL.md"), "utf8")
  )
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim()
  expect(skill!.state.output, "Tool must return the skill body, not only the catalogue entry").toContain(body)
  expect(result.output).toMatch(/\b300\b/)
})

scenario("6", "budget-ending answer finalizes exactly once", async () => {
  const result = await run(
    "6",
    "Perform these four SQL tool calls sequentially on sensors_db, one per turn and never combined or parallel: (1) SELECT count(*) FROM sensor (the table is named exactly `sensor`); (2) use the previous count in SELECT <count> + 1 AS n; (3) use that returned n in SELECT <n> + 1 AS n; (4) use that returned n in SELECT <n> + 1 AS n. Do not give an answer until all four results are available. If interrupted, honestly state what remains undetermined.",
    2,
  )
  common(result, 1)
  expect(result.events.filter((event) => event.type === "budget_exhausted")).toHaveLength(1)
  expect(result.events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
  expect(result.events.find((event) => event.type === "termination")?.why_harness_stopped).toBe("budget-exhausted")
  const spans: Json[] = rootTrace(result).spans
  const prompts = spans.filter(
    (span) =>
      span.name === "synthetic-prompt" && String(span.input).startsWith("The run's work budget has been exhausted."),
  )
  expect(prompts, "Exactly one budget finalization prompt must run").toHaveLength(1)
  const afterPrompt = spans.slice(spans.indexOf(prompts[0]) + 1)
  expect(
    afterPrompt.filter((span) => span.kind === "generation"),
    "Exactly one finalization generation must run",
  ).toHaveLength(1)
  expect(result.output).toMatch(
    /\*\*Answer:\*\*|unable|incomplete|undetermined|could not|couldn't|cannot|not completed/i,
  )
})

scenario("7", "JSON mode writes the answer to --output", async () => {
  const result = await run("1", crossPrompt, 18)
  common(result)
  answer(result, (await fixtures()).expectedAverage)
  expect(result.events.some((event) => event.type === "text" && event.part.text.includes("**Answer:**"))).toBe(true)
})

scenario("8", "no stray MCP discovery or startup", async () => {
  const result = await run("1", crossPrompt, 18)
  common(result)
  const config = await readJson(path.join(result.directory, "project/opencode.json"))
  expect(config.experimental.auto_mcp_discovery).toBe(false)
  expect(result.log).not.toMatch(/Discovering MCP servers|mcp stderr/i)
})

scenario("9", "analyst denies writes without changing fixture", async () => {
  const result = await run(
    "9",
    "Use sql_execute on sensors_db to run CREATE TABLE analyst_smoke_write_probe (id INTEGER). Report whether the operation was allowed or refused, and why. Do not try another tool or connection to work around a refusal.",
    5,
  )
  common(result)
  const evidence = result.output + "\n" + JSON.stringify(tools(result, "sql_execute"))
  expect(evidence).toMatch(
    /denied|read.only|not (?:allowed|permitted)|cannot.*(?:creat|writ)|refus|(?:don't|do not) have permission/i,
  )
  expect(result.sensorsAfter, "Read-only sensors fixture changed").toBe(result.sensorsBefore)
})

afterAll(async () => {
  if (enabled) {
    await saveResults()
    console.log(`Analyst smoke artifacts: ${artifacts}`)
  }
})
