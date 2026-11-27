/**
 * Adversarial coverage for the v0.12.12 payload (v0.12.11..HEAD), on top of the suites each PR shipped
 * with. The largest changes are the dbt Power User tools (#1729-#1738, #1761, #1768), the SQL
 * classification hardening for the tool CLI and MCP server (#1644) and the `altimate integrations`
 * command (#1622); each carries its own suite.
 *
 * This file adds the boundary classes those suites do not reach, and covers the release review fixes:
 *
 *   - The classifier's hard-deny list for the DROP forms #1644 added, and that Jinja keeps a read from
 *     being read as one.
 *   - `readRunResults` against non-files, non-JSON, prototype keys, an oversized file (the review's size
 *     cap) and a UNC target path (the review's `isAbsolutePath` fix).
 *   - `sql_explain`'s refusal naming a backslash on Snowflake rather than an unterminated quote.
 *   - The dbt adapter refusal naming plan mode, and source guards for the integrations API overrides.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { classifyAndCheck, mentionsHardDenyAnywhere } from "@/altimate/tools/sql-classify"
import { readRunResults, resolveDbtTargetPath } from "@/altimate/validators/validator-utils"
import { dbtAdapterFor } from "@/altimate/tools/dbt-adapter-access"
import { SqlExplainTool } from "@/altimate/tools/sql-explain"
import * as Registry from "@/altimate/native/connections/registry"
import { initTool } from "../altimate/tool-fixture"
import { resolveReviewBase } from "@/altimate/review/git"
import { credentialsInternals } from "@/altimate/integrations/credentials"
import { tokenizeSql } from "@/altimate/tools/sql-tokenize"
import { DbtBuildGreenValidator } from "@/altimate/validators/dbt-build-green"

const src = path.join(import.meta.dir, "../../src")
const read = (file: string) => fs.readFile(path.join(src, file), "utf8")

const ctx = (extra: Partial<Tool.Context> = {}): Tool.Context => ({
  sessionID: SessionID.make("ses_release_v01212"),
  messageID: MessageID.make("msg_release_v01212"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  ...extra,
})

describe("v0.12.12: SQL classification hardening (#1644)", () => {
  test("the new DROP forms are hard-denied wherever they appear", () => {
    for (const sql of ["DROP CATALOG c", "drop  namespace n", "DROP EXTERNAL SCHEMA s", "DROP PLUGGABLE DATABASE p", "select 1; DROP CATALOG c"]) {
      expect(classifyAndCheck(sql, "snowflake").blocked).toBe(true)
      expect(mentionsHardDenyAnywhere(sql)).toBe(true)
    }
  })
  test("a function or column named after a keyword stays a read", () => {
    for (const sql of ["select truncate(x, 2) from t", "select a as truncate from t", "select 'DROP SCHEMA s' as note"]) {
      const r = classifyAndCheck(sql, "snowflake")
      expect([r.queryType, r.blocked]).toEqual(["read", false])
    }
  })
  test("non-ASCII identifiers and strings are reads", () => {
    for (const sql of ['select "Straße", name from kunden where stadt = \'München\'', "select 日本 from t"])
      expect(classifyAndCheck(sql, "snowflake").queryType).toBe("read")
  })
})

describe("v0.12.12: readRunResults against hostile files", () => {
  let root: string
  // An inherited DBT_TARGET_PATH would point readRunResults at another folder.
  const savedTarget = process.env.DBT_TARGET_PATH
  beforeEach(async () => {
    delete process.env.DBT_TARGET_PATH
    root = await fs.mkdtemp(path.join(os.tmpdir(), "release-v0.12.12-"))
    await fs.mkdir(path.join(root, "target"))
  })
  afterEach(async () => {
    if (savedTarget === undefined) delete process.env.DBT_TARGET_PATH
    else process.env.DBT_TARGET_PATH = savedTarget
    await fs.rm(root, { recursive: true, force: true })
  })
  const write = (text: string) => fs.writeFile(path.join(root, "target", "run_results.json"), text)

  test("no file, a directory, non-JSON and an object without results are no evidence", async () => {
    expect(await readRunResults(root)).toBeNull()
    await fs.mkdir(path.join(root, "target", "run_results.json"))
    expect(await readRunResults(root)).toBeNull()
    await fs.rm(path.join(root, "target", "run_results.json"), { recursive: true })
    for (const text of ["", "not json", "[]", "null", '{"results":{}}', '{"__proto__":{"results":[]}}']) {
      await write(text)
      expect(await readRunResults(root)).toBeNull()
    }
    expect(Object.prototype).not.toHaveProperty("results")
  })

  test("a file over the size cap is not read", async () => {
    const file = path.join(root, "target", "run_results.json")
    await write('{"results":[]}')
    // A sparse file on POSIX: the size is over the cap without writing the bytes.
    await fs.truncate(file, 257 * 1024 * 1024)
    // The cap, not a parse failure, must reject it: the file is never read.
    const read = spyOn(fsp, "readFile")
    try {
      expect(await readRunResults(root)).toBeNull()
      expect(read.mock.calls.some(([p]) => String(p) === file)).toBe(false)
    } finally {
      read.mockRestore()
    }
  })

  test("a file of exactly the size cap is still read", async () => {
    const file = path.join(root, "target", "run_results.json")
    await write("{}")
    await fs.truncate(file, 256 * 1024 * 1024)
    // The bytes are not materialized: the read answers a small artifact for this file.
    const read = spyOn(fsp, "readFile").mockResolvedValue('{"results":[]}' as any)
    try {
      expect(await readRunResults(root)).not.toBeNull()
      expect(read.mock.calls.some(([p]) => String(p) === file)).toBe(true)
    } finally {
      read.mockRestore()
    }
  })

  test("an artifact over the cap is no build evidence for the build-green gate", async () => {
    await fs.writeFile(path.join(root, "dbt_project.yml"), "name: t\nversion: '1.0'\nconfig-version: 2\nprofile: t\n")
    await fs.mkdir(path.join(root, "models"))
    await fs.writeFile(path.join(root, "models", "stg_orders.sql"), "select 1 as id")
    const file = path.join(root, "target", "run_results.json")
    await write(JSON.stringify({ results: [{ unique_id: "model.t.stg_orders", status: "success" }] }))
    await fs.truncate(file, 257 * 1024 * 1024)
    const r = await DbtBuildGreenValidator.check({ sessionID: "s", workingDirectory: root, sessionStartMs: 0, step: 1, retryCount: 0 })
    expect(r.ok).toBe(false)
    expect(r.details!["verdict"]).toBe("no-fresh-build")
  })

  test("a well-formed file is read", async () => {
    await write(JSON.stringify({ results: [], args: { which: "build" }, elapsed_time: 1 }))
    expect(await readRunResults(root)).not.toBeNull()
  })

  test("a UNC or drive-letter target path is used as given, not joined onto the project", async () => {
    for (const target of ["\\\\server\\share\\target", "C:\\dbt\\target", "/abs/target"])
      expect(await resolveDbtTargetPath(root, target)).toBe(target)
    expect(await resolveDbtTargetPath(root, "custom")).toBe(path.join(root, "custom"))
  })
})

describe("v0.12.12: refusal messages name the real cause", () => {
  afterEach(() => Registry.reset())

  test("sql_explain on Snowflake names the backslash, not an unterminated quote", async () => {
    Registry.setConfigs({ sf: { type: "snowflake" } as any })
    const tool = await initTool(SqlExplainTool)
    for (const sql of ["select regexp_replace(a, '\\\\d+', '') from t", "select * from f where p like 'C:\\\\Users\\\\%'"]) {
      const result = await tool.execute({ sql, warehouse: "sf", analyze: false }, ctx())
      expect(result.metadata.success).toBe(false)
      expect(result.output).toContain("backslash")
      expect(result.output).not.toContain("unterminated")
    }
  })

  test("sql_explain still names an unterminated quote when there is no backslash", async () => {
    Registry.setConfigs({ sf: { type: "snowflake" } as any })
    const tool = await initTool(SqlExplainTool)
    const result = await tool.execute({ sql: "select 'abc", warehouse: "sf", analyze: false }, ctx())
    expect(result.output).toContain("unterminated")
  })

  test("the backslash hint appears only when a backslash is why the quotes could not be read", async () => {
    Registry.setConfigs({ pg: { type: "postgres" } as any, lite: { type: "sqlite" } as any, my: { type: "mysql" } as any })
    const tool = await initTool(SqlExplainTool)
    const explain = (sql: string, warehouse: string) => tool.execute({ sql, warehouse, analyze: false }, ctx())
    // An unterminated quote in SQL that also holds a backslash elsewhere: the backslash is not the cause.
    for (const [sql, warehouse] of [
      ["select regexp_replace(a, '\\d', '') || 'abc from t", "pg"],
      ["select 'C:\\dir' || 'abc from t", "lite"],
    ]) {
      const out = (await explain(sql, warehouse)).output
      expect(out).toContain("unterminated")
      expect(out).not.toContain("backslash")
    }
    // A quote after a backslash: PostgreSQL with standard_conforming_strings off, and MySQL, read it as escaped.
    for (const [sql, warehouse] of [
      ["select 'it\\'s' from t", "pg"],
      ["select 'a\\b' from t", "my"],
    ]) {
      const out = (await explain(sql, warehouse)).output
      expect(out).toContain("backslash")
      expect(out).toContain("CHR(92) or CHAR(92)")
    }
  })

  test("tokenizeSql reports a backslash cause only for a backslash", () => {
    expect(tokenizeSql("select 'abc", "postgres")).toMatchObject({ complete: false, backslash: false })
    expect(tokenizeSql("select 'it\\'s'", "postgres")).toMatchObject({ complete: false, backslash: true })
    // BigQuery escapes with a backslash, so a string left open after one most likely ends in an escaped quote.
    expect(tokenizeSql("select 'abc\\'", "bigquery")).toMatchObject({ complete: false, backslash: true })
    expect(tokenizeSql("select 'a\\b'", "sqlite")).toMatchObject({ complete: true, backslash: false })
  })

  test("the dbt adapter refusal names only the fix that applies: plan mode, or --allow-write", async () => {
    const plan = await dbtAdapterFor(ctx({ agent: "plan" }))
    const readOnly = await dbtAdapterFor(ctx({ extra: { forceReadOnly: true } }))
    for (const access of [plan, readOnly]) {
      expect(access.adapter).toBeUndefined()
      expect(access.refusal).toBe("read_only")
    }
    expect(plan.reason).toContain("outside plan mode")
    expect(plan.reason).not.toContain("--allow-write")
    expect(readOnly.reason).toContain("--allow-write")
    expect(readOnly.reason).not.toContain("plan mode")
  })

  test("a cancelled call is not answered with a refusal", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(dbtAdapterFor(ctx({ abort: abort.signal, agent: "plan" }))).rejects.toBeDefined()
  })
})

describe("v0.12.12: integration API overrides receive the token only on https or this machine", () => {
  const NAME = "ALTIMATE_INTEGRATIONS_GITHUB_API"
  const saved = process.env[NAME]
  afterEach(() => {
    if (saved === undefined) delete process.env[NAME]
    else process.env[NAME] = saved
  })
  const override = (value: string) => {
    process.env[NAME] = value
    return credentialsInternals.apiOverride(NAME)
  }
  test("https and a local http address are used", () => {
    for (const v of ["https://ghe.example/api/v3", "http://127.0.0.1:8080", "http://localhost", "http://[::1]:9/x"]) expect(override(v)).toBe(v)
  })
  test("userinfo before a remote host, credentials, a remote http host and junk are ignored", () => {
    for (const v of [
      "http://localhost:1234@evil.example",
      "http://127.0.0.1@evil.example/",
      "https://user:pass@ghe.example",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://ghe.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "   ",
    ])
      expect(override(v)).toBeUndefined()
  })
})

describe("v0.12.12: the missing-fields hint re-runs the call that failed", () => {
  // An empty environment with only bun on PATH: no gh login or token can be detected and used.
  const run = async (...args: string[]) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-v0.12.12-hint-"))
    try {
      await fs.mkdir(path.join(dir, "bin"))
      await fs.symlink(process.execPath, path.join(dir, "bin", "bun"))
      const cli = path.join(import.meta.dir, "../../src/index.ts")
      const p = Bun.spawnSync([path.join(dir, "bin", "bun"), "run", cli, "integrations", ...args], {
        // NODE_ENV and ALTIMATE_TELEMETRY_DISABLED keep the child from sending telemetry.
        env: {
          HOME: dir,
          PATH: path.join(dir, "bin"),
          ALTIMATE_INTEGRATIONS_DIR: dir,
          ALTIMATE_INTEGRATIONS_MOCK: "1",
          NODE_ENV: "test",
          ALTIMATE_TELEMETRY_DISABLED: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      return p.stdout.toString() + p.stderr.toString()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  test("--local-only is kept, so following the hint does not sync the credential", async () => {
    const out = await run("connect", "github", "--local-only")
    expect(out).toContain("Missing:")
    expect(out).toContain("`altimate integrations connect github --local-only` again")
  }, 60_000)

  test("--variant goes on fields and the re-run, and --share is kept", async () => {
    const out = await run("connect", "jira", "--variant", "server", "--share")
    expect(out).toContain("`altimate integrations fields jira --variant server`")
    expect(out).toContain("`altimate integrations connect jira --variant server --share` again")
  }, 60_000)

  test("a variant named by its label is quoted, so the copied command parses", async () => {
    const out = await run("connect", "jira", "--variant", "Jira Server / Data Center")
    expect(out).toContain("`altimate integrations fields jira --variant 'Jira Server / Data Center'`")
  }, 60_000)
})

describe("v0.12.12: source guards", () => {
  test("integration API overrides are used only for https or a local http address", async () => {
    const text = await read("altimate/integrations/credentials.ts")
    for (const name of ["ALTIMATE_INTEGRATIONS_GITHUB_API", "ALTIMATE_INTEGRATIONS_LINEAR_API", "ALTIMATE_INTEGRATIONS_JIRA_API"]) {
      expect(text).toContain(`apiOverride("${name}")`)
      expect(text).not.toContain(`process.env.${name}`)
    }
  })

  test("the nine dbt Power User tools stay out of the in-session agent registry", async () => {
    const registry = await read("tool/registry.ts")
    for (const name of ["DbtCostEstimateTool", "DbtCteProfileTool", "DbtDeferStateTool", "DbtDocsCoverageTool", "DbtHealthTool", "DbtMapRelationsTool", "DbtRunResultsTool", "DbtSqlGraphTool", "DocsShareCommentsTool"])
      expect(registry).not.toContain(name)
  })
})

describe("v0.12.12: altimate review refs and remote-config errors", () => {
  for (const [field, opts] of [
    ["--base", { base: "--output=/tmp/x" }],
    ["--head", { base: "main", head: "-c" }],
  ] as const) {
    test(`a ${field} that starts with "-" is refused before git sees it`, async () => {
      await expect(resolveReviewBase({ ...opts, cwd: os.tmpdir(), env: {} })).rejects.toThrow(`${field} `)
      await expect(resolveReviewBase({ ...opts, cwd: os.tmpdir(), env: {} })).rejects.toThrow('cannot start with "-"')
    })
  }

  test("remote-config errors and the debug log never interpolate the substituted URL", async () => {
    const text = await read("config/config.ts")
    expect(text).not.toContain("failed to decode remote config from ${remote.url}")
    expect(text).not.toContain("failed to decode remote config from ${url}")
    expect(text).not.toContain('logDebug("fetching remote config", { url: remote.url })')
  })
})
