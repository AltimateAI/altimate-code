// altimate_change - new file
//
// Unit coverage for the workspace tool-awareness section: the model-facing statement
// of what the bound workspace serves. Driven through the real `refresh` so the
// section is always rendered from a snapshot the guard would agree with, rather than
// from a hand-built object that could drift from what precedence actually derives.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MAX_SECTION_CHARS, systemSection } from "../../../src/altimate/workspace/awareness"
import type { Precedence } from "../../../src/altimate/workspace/precedence"
import { forSession, precedenceInternals, refresh, resetForTests } from "../../../src/altimate/workspace/precedence"
import * as Registry from "../../../src/altimate/native/connections/registry"

const SESSION = "ses_awareness"
const ORIGINAL_INTEGRATIONS = process.env.ALTIMATE_INTEGRATIONS
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE

/** Snowflake is the only integration serving all three capabilities. */
const SNOWFLAKE_TOOLS = {
  datamate_snowflake_execute_database_query: {},
  datamate_snowflake_get_query_explain_plan: {},
  datamate_snowflake_get_table_stats: {},
  datamate_snowflake_list_database_connections: {},
}

/** BigQuery ships execute only — no explain, no table stats. */
const BIGQUERY_TOOLS = {
  datamate_bigquery_execute_database_query: {},
  datamate_bigquery_list_database_connections: {},
}

function bindTo(id = 42, name = "analytics") {
  precedenceInternals.binding = async () => ({ datamateId: id, datamateName: name })
  precedenceInternals.attributedTo = async () => String(id)
  precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
}

/** Render whatever the session's current snapshot says, the way prompt.ts does. */
const section = () => systemSection(forSession(SESSION))

beforeEach(() => {
  resetForTests()
  delete process.env.ALTIMATE_INTEGRATIONS
  process.env.ALTIMATE_WORKSPACE = "1"
  bindTo()
  Registry.setConfigs({
    local_snow: { type: "snowflake", account: "acct", user: "u" } as never,
    local_duck: { type: "duckdb", path: ":memory:" } as never,
    bq_conn: { type: "bigquery", project: "p" } as never,
  })
})

afterEach(() => {
  resetForTests()
  Registry.reset()
  if (ORIGINAL_INTEGRATIONS === undefined) delete process.env.ALTIMATE_INTEGRATIONS
  else process.env.ALTIMATE_INTEGRATIONS = ORIGINAL_INTEGRATIONS
  if (ORIGINAL_PILOT === undefined) delete process.env.ALTIMATE_WORKSPACE
  else process.env.ALTIMATE_WORKSPACE = ORIGINAL_PILOT
})

describe("the section is silent unless the workspace is really routing", () => {
  test("no snapshot at all renders nothing", () => {
    // The resolver derives one every turn, so this is a caller that never resolved
    // tools. Nothing is known, so nothing is claimed.
    expect(systemSection(undefined)).toBe("")
  })

  test("the pilot being off renders nothing", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(forSession(SESSION)?.disabledReason).toBe("pilot-off")
    expect(section()).toBe("")
  })

  test("an unbound project renders nothing", async () => {
    precedenceInternals.binding = async () => null
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(forSession(SESSION)?.disabledReason).toBe("unbound")
    expect(section()).toBe("")
  })

  test("an engine that cannot be attributed renders nothing", async () => {
    // The running engine could not be proven to serve THIS workspace. Precedence
    // refuses, so the section must not tell the model to use it.
    precedenceInternals.attributedTo = async () => "999"
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(forSession(SESSION)?.disabledReason).toBe("unattributed")
    expect(section()).toBe("")
  })

  test("a declared-but-absent integration renders nothing", async () => {
    await refresh(SESSION, {})
    expect(forSession(SESSION)?.disabledReason).toBe("nothing-materialised")
    expect(section()).toBe("")
  })
})

describe("the escape hatch", () => {
  test("says so explicitly rather than falling silent", async () => {
    // Engine tools can still materialise with the hatch on — `derive` refuses before
    // it looks at them, but MCP connects the configured entry regardless. Silence
    // would leave the model free to use tools it can see and should not.
    process.env.ALTIMATE_INTEGRATIONS = "local"
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(forSession(SESSION)?.disabledReason).toBe("escape-hatch")
    const out = section()
    expect(out).toContain("--integrations=local")
    expect(out).toContain("`sql_execute`")
    expect(out).not.toContain("datamate_snowflake_execute_database_query")
  })
})

describe("what the section tells the model", () => {
  test("names the exact engine key for every served capability", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const out = section()
    expect(out).toContain("## Workspace integrations")
    expect(out).toContain('workspace "analytics"')
    expect(out).toContain("`datamate_snowflake_execute_database_query`")
    expect(out).toContain("`datamate_snowflake_get_query_explain_plan`")
    expect(out).toContain("`datamate_snowflake_get_table_stats`")
  })

  test("never claims a capability the integration does not serve", async () => {
    // The asymmetry that matters: BigQuery serves execute only. Telling the model
    // bigquery is "served" would steer it off `sql_explain`, which is the only tool
    // that can actually explain a BigQuery query.
    await refresh(SESSION, BIGQUERY_TOOLS)
    const out = section()
    expect(out).toContain("`datamate_bigquery_execute_database_query`")
    expect(out).toContain("stay on the local")
    expect(out).toContain("`sql_explain`")
    expect(out).toContain("`schema_inspect`")
    expect(out).not.toContain("datamate_bigquery_get_query_explain_plan")
  })

  test("carries the converse so unserved types keep running locally", async () => {
    // Without this the section reads as "prefer the workspace for everything", which
    // is the over-steering failure mode: a DuckDB connection has no engine tool at
    // all, so a model that avoids the local tools cannot do the work.
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const out = section()
    expect(out).toContain("Every other connection type uses the local tools")
    expect(out).toContain("Do not use `datamate_*` warehouse tools for connection types that are not listed")
  })

  test("lists each served type once, with both integrations present", async () => {
    await refresh(SESSION, { ...SNOWFLAKE_TOOLS, ...BIGQUERY_TOOLS })
    const out = section()
    expect(out.match(/^- snowflake — /gm)?.length).toBe(1)
    expect(out.match(/^- bigquery — /gm)?.length).toBe(1)
  })

  test("drops the section when the agent may not call any engine tool", async () => {
    // The `analyst` shape: permitted the native reads, forbidden everything it does
    // not name. A redirect it cannot follow is a dead end, so precedence keeps those
    // calls local — and the section must agree rather than advertise the engine.
    const analystLike = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "sql_execute", pattern: "*", action: "allow" as const },
      { permission: "sql_explain", pattern: "*", action: "allow" as const },
      { permission: "schema_inspect", pattern: "*", action: "allow" as const },
    ]
    await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    expect(section()).toBe("")
  })
})

describe("the size ceiling", () => {
  test("stays under the cap and degrades by dropping whole types", async () => {
    // Four integrations x three capabilities is far under the cap today; the cap
    // exists so an engine advertising many integrations degrades predictably rather
    // than crowding the prompt. Synthesised here to exercise that path.
    const many: Record<string, unknown> = {}
    for (const id of ["snowflake", "bigquery", "postgresql", "databricks"]) {
      many[`datamate_${id === "databricks" ? "databricks_execute_sql" : `${id}_execute_database_query`}`] = {}
      many[`datamate_${id}_get_query_explain_plan`] = {}
      many[`datamate_${id}_get_table_stats`] = {}
    }
    Registry.setConfigs({
      s: { type: "snowflake", account: "a", user: "u" } as never,
      b: { type: "bigquery", project: "p" } as never,
      p: { type: "postgresql", host: "h" } as never,
      d: { type: "databricks", host: "h" } as never,
    })
    await refresh(SESSION, many)
    const out = section()
    expect(out.length).toBeLessThanOrEqual(MAX_SECTION_CHARS)
    expect(out).toContain("Every other connection type uses the local tools")
  })
})

describe("the regression guard", () => {
  // The whole safety case for shipping this: a session that is not routing must
  // assemble exactly the system prompt it did before this module existed. These two
  // tests are what make that checkable rather than merely argued.

  test("every disabled reason is decided explicitly, and only the hatch speaks", () => {
    // Typed as the union, so adding a `disabledReason` without deciding what the
    // model should be told fails to compile rather than silently rendering "".
    const reasons: NonNullable<Precedence["disabledReason"]>[] = [
      "pilot-off",
      "escape-hatch",
      "unbound",
      "unattributed",
      "nothing-materialised",
    ]
    for (const reason of reasons) {
      const snapshot: Precedence = {
        workspaceName: "analytics",
        enabled: false,
        disabledReason: reason,
        shadowed: new Map(),
      }
      const out = systemSection(snapshot)
      if (reason === "escape-hatch") expect(out).toContain("--integrations=local")
      else expect(out).toBe("")
    }
  })

  test("contributes nothing to the system array when it is not routing", async () => {
    // Mirrors the spread in prompt.ts. An unbound session must produce an array that
    // is element-for-element what it was before the section was introduced.
    const assemble = (section: string) => ["environment", "skills", ...(section ? [section] : []), "instructions"]
    const before = ["environment", "skills", "instructions"]

    expect(assemble(systemSection(undefined))).toEqual(before)

    precedenceInternals.binding = async () => null
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(assemble(section())).toEqual(before)

    bindTo()
    await refresh(SESSION, {})
    expect(assemble(section())).toEqual(before)

    // ...and it DOES contribute once the workspace is really routing, so the test
    // above is not passing because the section is broken.
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(assemble(section()).length).toBe(4)
  })
})
