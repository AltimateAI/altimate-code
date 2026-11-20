/**
 * Adversarial coverage for the v0.12.12 payload (v0.12.11..HEAD), on top of the suites each PR shipped
 * with. The largest changes are the dbt Power User tools (#1729-#1738, #1761, #1768), the SQL
 * classification hardening for the tool CLI and MCP server (#1644) and the `altimate integrations`
 * command (#1622); each carries its own suite.
 *
 * This file adds the boundary classes those suites do not reach, and covers the release review fixes:
 *
 *   - `dbt_cost_estimate`'s script check against statement smuggling on Snowflake and Databricks, its Jinja
 *     literal against breaking out of the string, and its plan parsers against hostile JSON.
 *   - The classifier's hard-deny list for the DROP forms #1644 added, and that Jinja keeps a read from
 *     being read as one.
 *   - `readRunResults` against non-files, non-JSON, prototype keys, an oversized file (the review's size
 *     cap) and a UNC target path (the review's `isAbsolutePath` fix).
 *   - `sql_explain`'s refusal naming a backslash on Snowflake rather than an unterminated quote.
 *   - The dbt adapter refusal naming plan mode, and source guards for the integrations API overrides.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import {
  explainJinja,
  formatBytes,
  mayBeScript,
  parseDatabricksExplainCost,
  parseSnowflakeExplain,
  readsFiles,
} from "@/altimate/tools/dbt-cost-estimate"
import { classifyAndCheck, mentionsHardDenyAnywhere } from "@/altimate/tools/sql-classify"
import { readRunResults, resolveDbtTargetPath } from "@/altimate/validators/validator-utils"
import { dbtAdapterFor } from "@/altimate/tools/dbt-adapter-access"
import { SqlExplainTool } from "@/altimate/tools/sql-explain"
import * as Registry from "@/altimate/native/connections/registry"
import { initTool } from "../altimate/tool-fixture"
import { resolveReviewBase } from "@/altimate/review/git"

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

describe("v0.12.12: dbt_cost_estimate never sends a second statement", () => {
  const smuggled = [
    "select 1; drop table t",
    "select 1;\ndrop table t",
    "select 1 /* ; */; delete from t",
    "select $$; drop table t$$",
    "select 1 // ;\n; drop table t",
    "!set variable_substitution=true\nselect 1",
    "select 1 /* unclosed",
    "select 'unclosed",
    "execute immediate 'drop table t'",
    "select 1;select 2",
  ]
  for (const sql of smuggled)
    test(`Snowflake counts as a script: ${JSON.stringify(sql)}`, () => {
      expect(mayBeScript(sql, "snowflake")).toBe(true)
    })

  for (const sql of ["select 1; drop table t", "select 1 /* unclosed", "select `a;b`; drop table t"])
    test(`Databricks counts as a script: ${JSON.stringify(sql)}`, () => {
      expect(mayBeScript(sql, "databricks")).toBe(true)
    })

  test("a single statement with quoted semicolons and a trailing one is not a script", () => {
    expect(mayBeScript("select ';' as a, \"b;c\" from t -- ; trailing\n;", "snowflake")).toBe(false)
    expect(mayBeScript("select `a;b` from t;", "databricks")).toBe(false)
  })

  test("the empty string and whitespace are not scripts", () => {
    expect(mayBeScript("", "snowflake")).toBe(false)
    expect(mayBeScript("  \n\t ", "databricks")).toBe(false)
  })

  test("the Jinja literal cannot be closed by the SQL it carries", () => {
    for (const sql of ["select '}}' as a", "select 'x' ~ '{{ 7*7 }}'", "select '\\' as b", "select 'it''s'", "{% do run_query('drop table t') %}"]) {
      const jinja = explainJinja("EXPLAIN USING JSON", sql)
      const literal = jinja.match(/run_query\('((?:\\.|[^'\\])*)'\)/)
      expect(literal).not.toBeNull()
      // Unescaping the literal gives back exactly the statement: nothing leaked outside the quotes.
      expect(literal![1].replace(/\\(.)/g, "$1")).toBe(`EXPLAIN USING JSON\n${sql}`)
    }
  })

  test("Databricks queries that read files are refused", () => {
    for (const sql of ["select * from read_files('s3://b/x')", "SELECT * FROM cloud_files('/p', 'json')", "select * from json.`/tmp/a.json`"])
      expect(readsFiles(sql)).toBe(true)
    expect(readsFiles("select read_files_count from t")).toBe(false)
  })
})

describe("v0.12.12: plan parsers against hostile JSON", () => {
  const junk: unknown[] = [null, undefined, 0, -1, NaN, "", "{}", [], [null], {}, { __proto__: { bytesAssigned: 5 } }, JSON.parse('{"__proto__":{"GlobalStats":{"bytesAssigned":5}}}')]
  test("Snowflake: junk gives no estimate and does not throw", () => {
    for (const value of junk) expect(parseSnowflakeExplain(value)).toBeUndefined()
  })
  test("Snowflake: negative or non-numeric bytes give no estimate", () => {
    for (const bytesAssigned of [-1, "12", NaN, Infinity])
      expect(parseSnowflakeExplain([JSON.stringify({ GlobalStats: { bytesAssigned, partitionsAssigned: 1, partitionsTotal: 1 } })])).toBeUndefined()
  })
  test("Databricks: junk gives no estimate and does not throw", () => {
    for (const value of junk) expect(() => parseDatabricksExplainCost(value)).not.toThrow()
    for (const value of [null, undefined, 0, "", [], {}]) {
      const r = parseDatabricksExplainCost(value)
      expect(r === undefined || (typeof r === "object" && "noStats" in r)).toBe(true)
    }
  })
  test("formatBytes at the boundaries", () => {
    expect(formatBytes(0)).toBe("0.0 Bytes")
    expect(formatBytes(1023)).toBe("1023.0 Bytes")
    expect(formatBytes(1024)).not.toContain("Bytes")
    // The largest unit holds any size: no "undefined" unit.
    expect(formatBytes(Number.MAX_SAFE_INTEGER)).not.toContain("undefined")
    expect(formatBytes(1024 ** 8)).not.toContain("undefined")
  })
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
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "release-v0.12.12-"))
    await fs.mkdir(path.join(root, "target"))
  })
  afterEach(async () => {
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
    expect(({} as any).results).toBeUndefined()
  })

  test("a file over the size cap is not read", async () => {
    const file = path.join(root, "target", "run_results.json")
    await write('{"results":[]}')
    // A sparse file: the size is over the cap without writing the bytes.
    await fs.truncate(file, 257 * 1024 * 1024)
    expect(await readRunResults(root)).toBeNull()
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

  test("the dbt adapter refusal names plan mode and the flag", async () => {
    for (const c of [ctx({ agent: "plan" }), ctx({ extra: { forceReadOnly: true } })]) {
      const access = await dbtAdapterFor(c)
      expect(access.adapter).toBeUndefined()
      expect(access.refusal).toBe("read_only")
      expect(access.reason).toContain("--allow-write")
      expect(access.reason).toContain("plan mode")
    }
  })

  test("a cancelled call is not answered with a refusal", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(dbtAdapterFor(ctx({ abort: abort.signal, agent: "plan" }))).rejects.toBeDefined()
  })
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
    for (const name of ["DbtCostEstimateTool", "DbtHealthTool", "DbtCteProfileTool", "DbtRunResultsTool", "DocsShareCommentsTool"])
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
