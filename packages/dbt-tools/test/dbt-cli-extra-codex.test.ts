import { describe, test, expect } from "bun:test"
import { mock, beforeEach, afterEach } from "bun:test"
import * as realChildProcess from "child_process"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

const tmpRoot = join(import.meta.dir, ".tmp-extra-codex")
const defaultDbtPath = join(tmpRoot, "bin", "dbt")
const originalAltimateDbtPath = process.env.ALTIMATE_DBT_PATH

const mockExecFile = mock((cmd: string, args: string[], opts: any, cb: Function) => {
  cb(null, "", "")
})

mock.module("child_process", () => ({
  ...realChildProcess,
  execFile: mockExecFile,
}))

const { configure, execDbtShow, execDbtCompileInline } = await import("../src/dbt-cli")

function makeFakeExecutable(path: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "#!/bin/sh\nexit 0\n")
  chmodSync(path, 0o755)
}

function commandFailed(message: string, fields: Record<string, unknown> = {}) {
  const err: any = new Error(message)
  Object.assign(err, fields)
  return err
}

describe("dbt-cli extra regression coverage for PR #933", () => {
  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    makeFakeExecutable(defaultDbtPath)
    process.env.ALTIMATE_DBT_PATH = defaultDbtPath
    configure({})
    mockExecFile.mockReset()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    if (originalAltimateDbtPath === undefined) delete process.env.ALTIMATE_DBT_PATH
    else process.env.ALTIMATE_DBT_PATH = originalAltimateDbtPath
    configure({})
  })

  test("execDbtShow returns the complete query result shape from mixed JSON and garbage stdout", async () => {
    const rawSql = "select 1 as n"
    const compiledSql = "SELECT 1 AS n"
    const stdout = [
      "",
      "not json at all",
      JSON.stringify({ info: { level: "info", msg: "Running with dbt=1.9.0" } }),
      "{truncated",
      JSON.stringify({ data: { compiled_sql: compiledSql } }),
      JSON.stringify({ data: { preview: JSON.stringify([{ n: 1, label: "one" }]) } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, stdout, "")
    })

    const result = await execDbtShow(rawSql)
    expect(result).toEqual({
      columnNames: ["n", "label"],
      columnTypes: ["string", "string"],
      data: [{ n: 1, label: "one" }],
      rawSql,
      compiledSql,
    })
  })

  test("execDbtShow treats an empty preview array as a successful zero-row result without fallback", async () => {
    let calls = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      calls++
      cb(null, JSON.stringify({ result: { preview: [], sql: "SELECT * FROM empty_table" } }), "")
    })

    const result = await execDbtShow("select * from empty_table")
    expect(result.columnNames).toEqual([])
    expect(result.columnTypes).toEqual([])
    expect(result.data).toEqual([])
    expect(result.compiledSql).toBe("SELECT * FROM empty_table")
    expect(calls).toBe(1)
  })

  test("execDbtShow passes --limit 0 through to both JSON mode and plain-text fallback", async () => {
    const seenArgs: string[][] = []
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      seenArgs.push([...args])
      if (seenArgs.length === 1) {
        cb(null, JSON.stringify({ info: { msg: "unrecognized successful shape" } }), "")
      } else {
        cb(null, ["| n |", "| - |", "| 1 |"].join("\n"), "")
      }
    })

    const result = await execDbtShow("select 1 as n", 0)
    expect(result.data).toEqual([{ n: "1" }])
    expect(seenArgs).toHaveLength(2)
    expect(seenArgs[0]).toContain("--limit")
    expect(seenArgs[0]?.[seenArgs[0].indexOf("--limit") + 1]).toBe("0")
    expect(seenArgs[1]).toEqual(["show", "--inline", "select 1 as n", "--limit", "0"])
  })

  test("execDbtShow omits --limit entirely when the limit is undefined", async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      expect(args).not.toContain("--limit")
      cb(null, JSON.stringify({ data: { preview: '[{"n": 1}]' } }), "")
    })

    await expect(execDbtShow("select 1")).resolves.toMatchObject({ data: [{ n: 1 }] })
  })

  test("execDbtShow uses the last error-level log event across top-level and nested dbt shapes", async () => {
    const sensitiveSql = "select 'do_not_log_this_show_secret' as token"
    const stdout = [
      JSON.stringify({ level: "error", msg: "Encountered an error:" }),
      JSON.stringify({ info: { level: "error", msg: "Compilation Error: undefined macro final_macro" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(commandFailed(`Command failed: dbt show --inline ${sensitiveSql}`, { code: 1 }), stdout, "generic stderr")
    })

    const caught = (await execDbtShow(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).toBe("Compilation Error: undefined macro final_macro")
    expect(caught.message).not.toContain("Encountered an error")
    expect(caught.message).not.toContain("do_not_log_this_show_secret")
  })

  test("execDbtShow strips nested ANSI SGR sequences from structured error text", async () => {
    const stdout = JSON.stringify({
      info: {
        level: "error",
        msg: "\u001b[1mCompilation \u001b[31mError\u001b[0m\u001b[22m: bad ref",
      },
    })

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(commandFailed("Command failed", { code: 1 }), stdout, "")
    })

    const caught = (await execDbtShow("select 1").catch((e) => e)) as Error
    expect(caught.message).toBe("Compilation Error: bad ref")
    expect(caught.message).not.toContain("\u001b[")
  })

  test("execDbtShow redacts SQL when JSON parsing fails and only the plain-text fallback rejects", async () => {
    const sensitiveSql = "select 'plain_fallback_secret' as token"
    let calls = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      calls++
      if (calls === 1) {
        cb(null, JSON.stringify({ info: { msg: "valid but unparseable success payload" } }), "")
      } else {
        cb(
          commandFailed(`Command failed: dbt show --inline ${sensitiveSql}`, { code: 3 }),
          "",
          "",
        )
      }
    })

    const caught = (await execDbtShow(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).toBe(
      "Could not parse dbt show JSON output, and plain-text fallback failed: dbt exited with status 3",
    )
    expect(caught.message).not.toContain("plain_fallback_secret")
    expect(caught.message).not.toContain("--inline")
  })

  test("execDbtCompileInline parses compiled SQL despite mixed garbage JSON-line output", async () => {
    const stdout = [
      "dbt wrote a non-json warning",
      JSON.stringify({ info: { msg: "still running" } }),
      "{bad",
      JSON.stringify({ result: { compiled_code: "SELECT id FROM analytics.customers" } }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, stdout, "")
    })

    await expect(execDbtCompileInline("select * from {{ ref('customers') }}")).resolves.toEqual({
      sql: "SELECT id FROM analytics.customers",
    })
  })

  test("execDbtCompileInline falls back to trimmed plain text when JSON mode succeeds with no SQL", async () => {
    const seenArgs: string[][] = []
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: Function) => {
      seenArgs.push([...args])
      if (seenArgs.length === 1) cb(null, JSON.stringify({ info: { msg: "done" } }), "")
      else cb(null, "\n  SELECT 2 AS n  \n", "")
    })

    const result = await execDbtCompileInline("select 2 as n")
    expect(result).toEqual({ sql: "SELECT 2 AS n" })
    expect(seenArgs[0]).toEqual(["compile", "--inline", "select 2 as n", "--output", "json", "--log-format", "json"])
    expect(seenArgs[1]).toEqual(["compile", "--inline", "select 2 as n"])
  })

  test("execDbtCompileInline does not use SQL-looking stdout from a failed JSON-mode run", async () => {
    let calls = 0
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      calls++
      if (calls === 1) {
        const trap = JSON.stringify({ payload: { compiled: "SELECT should_not_be_returned FROM failed_stdout" } })
        cb(commandFailed("Command failed", { code: 1 }), trap, "Compilation Error: missing source")
      } else {
        cb(commandFailed("Command failed", { code: 1 }), "", "Compilation Error: missing source")
      }
    })

    await expect(execDbtCompileInline("select * from missing_source")).rejects.toThrow(
      "Compilation Error: missing source",
    )
    expect(calls).toBe(2)
  })

  test("execDbtCompileInline chooses the last structured error and redacts command-line SQL fallback text", async () => {
    const sensitiveSql = "select 'compile_inline_last_error_secret' as token"
    const stdout = [
      JSON.stringify({ info: { level: "error", msg: "Encountered an error:" } }),
      JSON.stringify({ level: "error", msg: "Runtime Error: final actionable inline failure" }),
    ].join("\n")

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(commandFailed(`Command failed: dbt compile --inline ${sensitiveSql}`, { code: 2 }), stdout, "")
    })

    const caught = (await execDbtCompileInline(sensitiveSql).catch((e) => e)) as Error
    expect(caught.message).toBe("Runtime Error: final actionable inline failure")
    expect(caught.message).not.toContain("Encountered an error")
    expect(caught.message).not.toContain("compile_inline_last_error_secret")
  })

  test("execDbtCompileInline surfaces spawn-time failures without adding command-line SQL", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(commandFailed("spawn /missing/dbt ENOENT", { code: "ENOENT" }), "", "")
    })

    const caught = (await execDbtCompileInline("select 'spawn_secret'").catch((e) => e)) as Error
    expect(caught.message).toBe("dbt compile inline failed: spawn /missing/dbt ENOENT")
    expect(caught.message).not.toContain("spawn_secret")
    expect(caught.message).not.toContain("--inline")
  })

  test("configure resets dbt resolution and run options honor pythonPath/projectRoot", async () => {
    delete process.env.ALTIMATE_DBT_PATH
    const projectRoot = join(tmpRoot, "project")
    const binDir = join(projectRoot, ".venv", "bin")
    const pythonPath = join(binDir, "python")
    const dbtPath = join(binDir, "dbt")
    makeFakeExecutable(pythonPath)
    makeFakeExecutable(dbtPath)
    configure({ pythonPath, projectRoot })

    mockExecFile.mockImplementation((cmd: string, _args: string[], opts: any, cb: Function) => {
      expect(cmd).toBe(dbtPath)
      expect(opts.cwd).toBe(projectRoot)
      expect(String(opts.env.PATH).startsWith(`${binDir}:`)).toBe(true)
      cb(null, JSON.stringify({ data: { preview: '[{"ok": true}]' } }), "")
    })

    await expect(execDbtShow("select true as ok")).resolves.toMatchObject({ data: [{ ok: true }] })
  })
})

describe("install.ps1 static safety checks", () => {
  test("Windows installer stays Bun-standalone and does not invoke npm/node install flows", () => {
    const text = readFileSync(join(import.meta.dir, "../../../install.ps1"), "utf-8")
    const executableLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("Write-"))
      .join("\n")

    expect(text).toContain("Bun-compiled standalone executable")
    expect(text).toContain("does NOT depend on npm/Node")
    expect(text).toContain("github.com/AltimateAI/altimate-code/releases")
    expect(executableLines).not.toMatch(/\bnpm\s+(install|i)\b/i)
    expect(executableLines).not.toMatch(/\bnode\s+.*install\b/i)
  })
})
