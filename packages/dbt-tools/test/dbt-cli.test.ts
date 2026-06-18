import { describe, test, expect, mock, beforeEach } from "bun:test"
import * as realChildProcess from "child_process"

// We test the parsing logic by mocking execFile.
// Spread the real module so other exports (execFileSync, etc.)
// remain available — mock.module leaks across test files in Bun.
const mockExecFile = mock((cmd: string, args: string[], opts: any, cb: Function) => {
  cb(null, "", "")
})

mock.module("child_process", () => ({
  ...realChildProcess,
  execFile: mockExecFile,
}))

// Import after mocking
const { execDbtShow, execDbtCompile, execDbtCompileInline, execDbtLs } = await import("../src/dbt-cli")

// ---------------------------------------------------------------------------
// execDbtShow
// ---------------------------------------------------------------------------
describe("execDbtShow", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  // --- Tier 1: known field paths ---

  test("Tier 1: parses data.preview (dbt 1.7-1.9 format)", async () => {
    const jsonLines = [
      JSON.stringify({ info: { msg: "Running..." } }),
      JSON.stringify({ data: { sql: "SELECT 1 AS n" } }),
      JSON.stringify({ data: { preview: '[{"n": 1}]' } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 1 AS n")
    expect(result.columnNames).toEqual(["n"])
    expect(result.data).toEqual([{ n: 1 }])
    expect(result.compiledSql).toBe("SELECT 1 AS n")
  })

  test("Tier 1: parses data.rows (alternative format)", async () => {
    const jsonLines = [JSON.stringify({ data: { rows: [{ name: "Alice" }, { name: "Bob" }] } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT name FROM users")
    expect(result.columnNames).toEqual(["name"])
    expect(result.data).toEqual([{ name: "Alice" }, { name: "Bob" }])
  })

  test("Tier 1: parses result.preview (hypothetical future format)", async () => {
    const jsonLines = [JSON.stringify({ result: { preview: [{ id: 42 }], sql: "SELECT 42" } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 42 AS id")
    expect(result.columnNames).toEqual(["id"])
    expect(result.data).toEqual([{ id: 42 }])
  })

  test("Tier 1: passes --limit flag when provided", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).toContain("--limit")
      expect(args).toContain("10")
      cb(null, JSON.stringify({ data: { preview: '[{"n": 1}]' } }), "")
    })

    const result = await execDbtShow("SELECT 1", 10)
    expect(result.data).toEqual([{ n: 1 }])
  })

  // --- Tier 2: heuristic deep scan ---

  test("Tier 2: finds row data nested in unknown structure", async () => {
    // Simulates a future dbt version with a completely different JSON shape
    const jsonLines = [
      JSON.stringify({
        level: "info",
        msg: "show done",
        payload: {
          query_results: [{ amount: 100 }, { amount: 200 }],
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT amount FROM orders")
    expect(result.columnNames).toEqual(["amount"])
    expect(result.data).toEqual([{ amount: 100 }, { amount: 200 }])
  })

  test("Tier 2: finds JSON string of rows nested deeply", async () => {
    const jsonLines = [
      JSON.stringify({
        event: {
          output: JSON.stringify([{ x: 1 }, { x: 2 }]),
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT x FROM t")
    expect(result.columnNames).toEqual(["x"])
    expect(result.data).toEqual([{ x: 1 }, { x: 2 }])
  })

  // --- Tier 3: plain text fallback ---

  test("Tier 3: parses ASCII table when JSON fails", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON attempt fails (no preview data)
        cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      } else {
        // Plain text ASCII table
        cb(null, ["| id | name  |", "| -- | ----- |", "| 1  | Alice |", "| 2  | Bob   |"].join("\n"), "")
      }
    })

    const result = await execDbtShow("SELECT id, name FROM users")
    expect(result.columnNames).toEqual(["id", "name"])
    expect(result.data).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ])
  })

  test("Tier 3: throws with helpful message when all tiers fail", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "some unparseable output", "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow("Could not parse dbt show output in any format")
  })

  // --- Bubble real dbt error instead of generic "Could not parse" ---
  //
  // IMPORTANT — faithful execFile wiring:
  //   Node's `execFile` passes `stdout`/`stderr` as the 2nd/3rd callback args
  //   on error, NOT as properties on the error object. The tests below
  //   intentionally do NOT pre-attach `err.stdout` / `err.stderr` — that
  //   would let the production code "work" through a mock-only quirk. The
  //   `run()` wrapper in dbt-cli.ts is responsible for moving the callback
  //   args onto the rejected error; if it stops doing that, these tests
  //   must fail.

  test("surfaces real dbt stderr when run fails", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed: dbt show --inline ...")
      err.code = 1
      cb(
        err,
        "",
        "Runtime Error: Failed to read package: No dbt_project.yml found at expected path dbt_packages/dbt_utils/dbt_project.yml",
      )
    })

    // The error already starts with "Runtime Error:" (a dbt category prefix),
    // so we intentionally do NOT add a "dbt show failed:" prefix in front.
    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/^Runtime Error: Failed to read package/)
  })

  test("prefers structured error event in JSON log over raw stderr", async () => {
    const errorLog = JSON.stringify({
      info: {
        level: "error",
        msg: "Compilation Error: Model 'foo' depends on a node named 'bar' which was not found",
      },
    })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, errorLog, "exit status 1")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/Compilation Error.*Model 'foo'/)
  })

  test("recognises top-level { level: 'error' } event shape (no nested info)", async () => {
    // extractDbtError handles both `l.info?.level === 'error'` and the
    // top-level `l.level === 'error'` shape. This test exercises the latter.
    const errorLog = JSON.stringify({
      level: "error",
      msg: "Database Error: connection to server lost",
    })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, errorLog, "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/connection to server lost/)
  })

  test("does not surface generic 'Could not parse' when dbt actually crashed", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 2
      cb(err, "", "Database Error: connection refused")
    })

    // Positive assertion: the real dbt error must be surfaced. The earlier
    // negation-only check would have passed even if some unrelated error
    // were thrown; the positive form below is sufficient on its own.
    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/Database Error.*connection refused/)
  })

  test("falls back to error message when stderr is empty", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("spawn ENOENT")
      err.code = "ENOENT"
      cb(err, "", "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/spawn ENOENT|dbt show failed/)
  })

  test("does NOT return rows from a crashed run's stdout (Tier 1/2 skip on error)", async () => {
    // If `run()` rejects, the JSON log lines from the crashed stdout MUST
    // NOT be fed into Tier 1/Tier 2 heuristics — a crash log can contain
    // incidental arrays that `looksLikeRowData` would happily return as
    // "rows" (silent wrong data, worse than the original misleading error).
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON-mode run crashes, but stdout has an incidental array of objects
        // nested in a log line. Pre-fix Tier 2 would happily match it.
        const err: any = new Error("Command failed")
        err.code = 1
        const trapLine = JSON.stringify({
          payload: { incidental_metadata: [{ unrelated: "log_entry" }, { unrelated: "another" }] },
        })
        cb(err, trapLine, "Database Error: connection refused")
      } else {
        // Plain-text retry also fails so the real error is what bubbles up.
        const err: any = new Error("Command failed")
        err.code = 1
        cb(err, "", "Database Error: connection refused")
      }
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/Database Error.*connection refused/)
    await expect(execDbtShow("SELECT 1")).rejects.not.toThrow(/unrelated/)
  })

  test("Tier 3 recovers: JSON-mode crashes but plain-text succeeds → returns the table", async () => {
    // Regression guard: even when the JSON-mode `dbt show --output json` run
    // rejects, we still attempt the plain-text retry and return the parsed
    // table if it succeeds. Throwing the JSON-mode error here would lose a
    // valid recovery path.
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        const err: any = new Error("Command failed")
        err.code = 1
        cb(err, "", "some json-mode-specific failure")
      } else {
        cb(null, ["| id | name  |", "| -- | ----- |", "| 1  | Alice |"].join("\n"), "")
      }
    })

    const result = await execDbtShow("SELECT id, name FROM users")
    expect(result.columnNames).toEqual(["id", "name"])
    expect(result.data).toEqual([{ id: "1", name: "Alice" }])
  })

  test("does NOT attribute parser failure to 'dbt show failed' when primary succeeded", async () => {
    // Regression: when the JSON-mode primary run exits 0 with output we can't
    // decode AND the plain-text retry fails for a different reason, the error
    // must distinguish the two cases. Throwing "dbt show failed: <plain-mode
    // error>" misattributes a parser regression as a dbt execution failure.
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // Primary JSON-mode run succeeds — exit 0, just an unrecognised shape.
        cb(null, JSON.stringify({ info: { msg: "done" }, unknown_shape: true }), "")
      } else {
        // Plain-text retry fails for an unrelated reason.
        const err: any = new Error("Command failed")
        err.code = 1
        cb(err, "", "some plain-mode-specific failure")
      }
    })

    // Capture the rejection once — the mock is stateful (callCount), so
    // calling execDbtShow twice would re-enter the mock from a different
    // count and exercise a different branch.
    const caught = (await execDbtShow("SELECT 1").catch((e) => e)) as Error
    expect(caught.message).toMatch(/Could not parse dbt show JSON output, and plain-text fallback failed/)
    // The error must NOT carry the "dbt show failed:" prefix — dbt show
    // itself succeeded; only the parser + retry failed.
    expect(caught.message).not.toMatch(/dbt show failed:/)
  })

  test("picks the LAST level:'error' event when dbt emits multiple", async () => {
    // dbt often emits a generic header first ("Encountered an error:") and the
    // actionable error second. We want the actionable one.
    const errorLog = [
      JSON.stringify({ info: { level: "error", msg: "Encountered an error:" } }),
      JSON.stringify({ info: { level: "info", msg: "Some info between" } }),
      JSON.stringify({
        info: { level: "error", msg: "Compilation Error in model 'orders': Undefined macro 'foo'" },
      }),
    ].join("\n")
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, errorLog, "")
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/Undefined macro 'foo'/)
    await expect(execDbtShow("SELECT 1")).rejects.not.toThrow(/Encountered an error:$/)
  })

  test("strips ANSI escape codes from surfaced errors", async () => {
    const ansiRed = "\u001b[31m"
    const ansiReset = "\u001b[0m"
    const errorLog = JSON.stringify({
      info: { level: "error", msg: `${ansiRed}Database Error${ansiReset}: connection refused` },
    })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, errorLog, "")
    })

    const caught = (await execDbtShow("SELECT 1").catch((e) => e)) as Error
    expect(caught.message).toContain("Database Error: connection refused")
    expect(caught.message).not.toContain("\u001b[")
  })

  test("does NOT embed full SQL into the surfaced error (no Command-failed leak)", async () => {
    // Node's execFile rejection has err.message = "Command failed: <dbt-path>
    // show --inline '<entire SQL>' ...". When no structured event or stderr
    // is available, the fallback must surface only the exit status, not the
    // full message with embedded SQL.
    const sensitiveSql = "SELECT 'PII_TOKEN_abc123' AS secret FROM users WHERE ssn = '999-00-0000'"
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      // Realistic Node message embeds the args (and so the SQL).
      const err: any = new Error(
        `Command failed: /usr/local/bin/dbt show --inline ${sensitiveSql} --output json --log-format json`,
      )
      err.code = 2
      cb(err, "", "")
    })

    const caught = (await execDbtShow(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).not.toContain("PII_TOKEN_abc123")
    expect(caught.message).not.toContain("999-00-0000")
    expect(caught.message).toMatch(/dbt show failed: dbt exited with status 2/)
  })

  test("does NOT leak SQL when dbt is killed by signal / timeout", async () => {
    // Timeout/signal kills also produce a `Command failed: <full command>`
    // message from Node. The redaction must catch this case too, not just
    // numeric exit codes.
    const sensitiveSql = "SELECT 'leak_canary_xyz' FROM secrets"
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error(
        `Command failed: /usr/local/bin/dbt show --inline ${sensitiveSql} --output json --log-format json`,
      )
      err.killed = true
      err.signal = "SIGTERM"
      cb(err, "", "")
    })

    const caught = (await execDbtShow(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).not.toContain("leak_canary_xyz")
    expect(caught.message).toMatch(/dbt show failed: dbt killed by signal SIGTERM/)
  })

  test("does NOT double the 'failed:' prefix when dbt's own category prefix is present", async () => {
    // dbt's own messages already start with "Database Error:",
    // "Compilation Error:", etc. Adding "dbt show failed: " in front yields
    // "dbt show failed: Database Error: ..." which is redundant.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, "", "Compilation Error in model 'foo'")
    })

    const caught = (await execDbtShow("SELECT 1").catch((e) => e)) as Error
    expect(caught.message).toBe("Compilation Error in model 'foo'")
    expect(caught.message).not.toMatch(/dbt show failed: (Compilation|Database|Runtime|Parsing|Validation|Dependency)\s+Error/)
  })

  test("handles Buffer-typed stdout/stderr from execFile", async () => {
    // ExecFileError.stdout/stderr is typed `string | Buffer` because Node's
    // execFile delivers Buffers when called with encoding: "buffer". Our
    // production calls don't set that, but the type widening means callers
    // could. Make sure .toString() / parseJsonLines / extractDbtError all
    // handle Buffers correctly.
    const errorLog = JSON.stringify({
      info: { level: "error", msg: "Database Error: connection refused" },
    })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, Buffer.from(errorLog), Buffer.from("exit status 1"))
    })

    await expect(execDbtShow("SELECT 1")).rejects.toThrow(/Database Error: connection refused/)
  })

  test("does NOT return malformed data when data.preview is a truthy non-array", async () => {
    // Regression for #944: the previewLine match only checks truthiness, so a
    // future dbt version emitting `data.preview = {}` would flow into `rows`
    // and the downstream `data: rows` field would crash callers that do
    // `.map` / `.length`. Treat unexpected shapes as empty rows instead.
    const jsonLines = [JSON.stringify({ data: { preview: {} } })].join("\n")
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 1")
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data).toEqual([])
    expect(result.columnNames).toEqual([])
  })

  test("also treats numeric data.preview as empty (defence-in-depth)", async () => {
    const jsonLines = [JSON.stringify({ data: { preview: 42 } })].join("\n")
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtShow("SELECT 1")
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// execDbtCompile
// ---------------------------------------------------------------------------
describe("execDbtCompile", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("Tier 1: parses data.compiled (dbt 1.7-1.9)", async () => {
    const jsonLines = [
      JSON.stringify({ info: { msg: "Compiling..." } }),
      JSON.stringify({ data: { compiled: "SELECT id FROM raw_orders" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("orders")
    expect(result.sql).toBe("SELECT id FROM raw_orders")
  })

  test("Tier 1: parses data.compiled_code (newer dbt)", async () => {
    const jsonLines = [JSON.stringify({ data: { compiled_code: "SELECT * FROM stg_orders" } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("orders")
    expect(result.sql).toBe("SELECT * FROM stg_orders")
  })

  test("Tier 1: parses result.node.compiled_code", async () => {
    const jsonLines = [JSON.stringify({ result: { node: { compiled_code: "SELECT 1" } } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT 1")
  })

  test("Tier 1: parses data.compiled_sql", async () => {
    const jsonLines = [JSON.stringify({ data: { compiled_sql: "SELECT 1 FROM foo" } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("foo")
    expect(result.sql).toBe("SELECT 1 FROM foo")
  })

  // --- Tier 2: heuristic ---

  test("Tier 2: finds SQL in unknown nested structure", async () => {
    const jsonLines = [
      JSON.stringify({
        event: {
          compilation_result: "SELECT id, name FROM public.customers WHERE active = true",
        },
      }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompile("customers")
    expect(result.sql).toBe("SELECT id, name FROM public.customers WHERE active = true")
  })

  // --- Tier 3: plain text ---

  test("Tier 3: falls back to plain text output", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      } else {
        cb(null, "SELECT * FROM final_model", "")
      }
    })

    const result = await execDbtCompile("my_model")
    expect(result.sql).toBe("SELECT * FROM final_model")
  })

  // --- Real dbt error bubbling (#943) ---

  test("surfaces real dbt stderr when compile fails", async () => {
    // Pre-fix: catch { lines = [] } swallowed the real error and the final
    // throw embedded Node's generic "Command failed: ..." message.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed: dbt compile --select foo ...")
      err.code = 1
      cb(err, "", "Compilation Error: Model 'foo' depends on a node named 'bar' which was not found")
    })

    await expect(execDbtCompile("foo")).rejects.toThrow(/Compilation Error.*Model 'foo'.*depends on a node named 'bar'/)
  })

  test("prefers structured JSON error event over raw stderr", async () => {
    const errorLog = JSON.stringify({
      info: { level: "error", msg: "Database Error: relation does not exist" },
    })
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, errorLog, "exit status 1")
    })

    await expect(execDbtCompile("foo")).rejects.toThrow(/Database Error: relation does not exist/)
  })

  test("does not double the 'dbt compile failed:' prefix on dbt category errors", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed")
      err.code = 1
      cb(err, "", "Compilation Error: model not found")
    })

    const caught = (await execDbtCompile("foo").catch((e) => e)) as Error
    expect(caught.message).toBe("Compilation Error: model not found")
    expect(caught.message).not.toMatch(/dbt compile failed: Compilation Error/)
  })
})

// ---------------------------------------------------------------------------
// execDbtCompileInline
// ---------------------------------------------------------------------------
describe("execDbtCompileInline", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("compiles inline SQL", async () => {
    const jsonLines = [JSON.stringify({ data: { compiled: "SELECT id, name FROM raw.customers" } })].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, jsonLines, "")
    })

    const result = await execDbtCompileInline("SELECT * FROM {{ ref('customers') }}")
    expect(result.sql).toBe("SELECT id, name FROM raw.customers")
  })

  // --- Real dbt error bubbling (#943) + SQL redaction (#945) ---

  test("surfaces real dbt error when inline compile fails", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error("Command failed: dbt compile --inline 'SELECT 1' ...")
      err.code = 1
      cb(err, "", "Compilation Error: Undefined macro 'unknown_macro'")
    })

    await expect(execDbtCompileInline("SELECT 1")).rejects.toThrow(/Compilation Error.*Undefined macro/)
  })

  test("does NOT embed inline SQL into the surfaced error (no Command-failed leak)", async () => {
    // Regression for #945: pre-fix the throw used `e.message` directly,
    // which is Node's "Command failed: <dbt-path> compile --inline '<entire
    // SQL>' …" format — leaking the user's full query into logs and UI.
    const sensitiveSql = "SELECT 'PII_TOKEN_compile_xyz' AS secret FROM users WHERE ssn = '111-22-3333'"
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error(
        `Command failed: /usr/local/bin/dbt compile --inline ${sensitiveSql} --output json --log-format json`,
      )
      err.code = 2
      cb(err, "", "")
    })

    const caught = (await execDbtCompileInline(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).not.toContain("PII_TOKEN_compile_xyz")
    expect(caught.message).not.toContain("111-22-3333")
    expect(caught.message).toMatch(/dbt compile inline failed: dbt exited with status 2/)
  })

  test("does NOT leak SQL when inline compile is killed by signal / timeout", async () => {
    const sensitiveSql = "SELECT 'compile_leak_canary' FROM secrets"
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error(
        `Command failed: /usr/local/bin/dbt compile --inline ${sensitiveSql} --output json --log-format json`,
      )
      err.killed = true
      err.signal = "SIGTERM"
      cb(err, "", "")
    })

    const caught = (await execDbtCompileInline(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).not.toContain("compile_leak_canary")
    expect(caught.message).toMatch(/dbt compile inline failed: dbt killed by signal SIGTERM/)
  })
})

// ---------------------------------------------------------------------------
// execDbtLs
// ---------------------------------------------------------------------------
describe("execDbtLs", () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  test("JSON format: lists children models", async () => {
    const jsonLines = [
      JSON.stringify({ name: "orders", unique_id: "model.jaffle.orders" }),
      JSON.stringify({ name: "customers", unique_id: "model.jaffle.customers" }),
      JSON.stringify({ name: "revenue", unique_id: "model.jaffle.revenue" }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).toContain("--select")
      expect(args[args.indexOf("--select") + 1]).toBe("orders+")
      cb(null, jsonLines, "")
    })

    const result = await execDbtLs("orders", "children")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "customers")).toBeTruthy()
    expect(result.find((r: any) => r.table === "revenue")).toBeTruthy()
  })

  test("JSON format: lists parent models", async () => {
    const jsonLines = [
      JSON.stringify({ name: "stg_orders", unique_id: "model.jaffle.stg_orders" }),
      JSON.stringify({ name: "stg_payments", unique_id: "model.jaffle.stg_payments" }),
      JSON.stringify({ name: "orders", unique_id: "model.jaffle.orders" }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args[args.indexOf("--select") + 1]).toBe("+orders")
      cb(null, jsonLines, "")
    })

    const result = await execDbtLs("orders", "parents")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "stg_orders")).toBeTruthy()
  })

  test("plain text fallback: parses unique_id lines", async () => {
    let callCount = 0
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      callCount++
      if (callCount === 1) {
        // JSON fails
        cb(new Error("--output json not supported"), "", "")
      } else {
        // Plain text: one unique_id per line
        cb(null, "model.jaffle.stg_orders\nmodel.jaffle.stg_payments\nmodel.jaffle.orders\n", "")
      }
    })

    const result = await execDbtLs("orders", "parents")
    expect(result.find((r: any) => r.table === "orders")).toBeUndefined()
    expect(result.find((r: any) => r.table === "stg_orders")).toBeTruthy()
    expect(result.find((r: any) => r.table === "stg_payments")).toBeTruthy()
  })

  test("handles empty output", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, "", "")
    })

    const result = await execDbtLs("isolated_model", "children")
    expect(result).toEqual([])
  })
})
