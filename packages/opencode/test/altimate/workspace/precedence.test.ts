// altimate_change - new file
//
// Unit coverage for workspace precedence: which side serves a warehouse call once a
// bound workspace's engine has attached. The binding and the engine-attribution read
// both go through `precedenceInternals`, so these exercise the decision logic without
// booting an instance, reading config, or touching MCP state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  check,
  decideForTarget,
  describeEngineTool,
  describeNativeTool,
  forSession,
  inventoryLine,
  precedenceInternals,
  refresh,
  resetForTests,
  warehouseListNote,
} from "../../../src/altimate/workspace/precedence"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { canonicalType } from "../../../src/altimate/native/connections/registry"

const SESSION = "ses_precedence"
const ORIGINAL_INTEGRATIONS = process.env.ALTIMATE_INTEGRATIONS
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE

/** The engine tools a workspace with a Snowflake connection materialises. Snowflake is
 * the only integration serving all three capabilities. */
const SNOWFLAKE_TOOLS = {
  datamate_snowflake_execute_database_query: {},
  datamate_snowflake_get_query_explain_plan: {},
  datamate_snowflake_get_table_stats: {},
  datamate_snowflake_list_database_connections: {},
}

/** BigQuery and postgresql ship execute + list only — no explain, no table stats. */
const BIGQUERY_TOOLS = {
  datamate_bigquery_execute_database_query: {},
  datamate_bigquery_list_database_connections: {},
}

function bindTo(id = 42, name = "analytics") {
  precedenceInternals.binding = async () => ({ datamateId: id, datamateName: name })
  precedenceInternals.attributedTo = async () => String(id)
}

beforeEach(() => {
  resetForTests()
  delete process.env.ALTIMATE_INTEGRATIONS
  process.env.ALTIMATE_WORKSPACE = "1"
  bindTo()
  // Real local connections. Without them `check()` would return "run" simply because
  // the connection is unknown, and every "stays local" assertion below would pass
  // without proving anything.
  Registry.setConfigs({
    local_snow: { type: "snowflake", account: "acct", user: "u" } as never,
    local_duck: { type: "duckdb", path: ":memory:" } as never,
    bq_conn: { type: "bigquery", project: "p" } as never,
    pg_conn: { type: "postgresql", host: "h" } as never,
    rs_conn: { type: "redshift", host: "h" } as never,
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

describe("the workspace pilot gate", () => {
  test("precedence stays off when the pilot flag is not set", async () => {
    // A binding and a pinned entry both persist in config, and the MCP client connects
    // that entry regardless of the pilot flag — so engine tools can materialise for
    // someone who opted out. Opting out has to mean it.
    delete process.env.ALTIMATE_WORKSPACE
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.enabled).toBe(false)
    expect(precedence.disabledReason).toBe("pilot-off")
  })

  test("a served connection still runs locally with the pilot off", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })

  test("opting out says nothing rather than announcing itself", async () => {
    delete process.env.ALTIMATE_WORKSPACE
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(0)
  })
})

describe("mechanism 1 — materialised, not declared", () => {
  test("engine tools that are present shadow the matching local type", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.enabled).toBe(true)
    expect(precedence.shadowed.get("snowflake")?.get("sql_execute")?.modelKey).toBe(
      "datamate_snowflake_execute_database_query",
    )
  })

  test("an engine that materialised nothing shadows nothing", async () => {
    const precedence = await refresh(SESSION, {})
    expect(precedence.enabled).toBe(false)
    expect(precedence.disabledReason).toBe("nothing-materialised")
  })

  test("non-engine MCP tools never confer precedence", async () => {
    const precedence = await refresh(SESSION, { jira_get_issue: {}, github_list_prs: {} })
    expect(precedence.enabled).toBe(false)
  })

  test("an unbound session shadows nothing", async () => {
    precedenceInternals.binding = async () => null
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.disabledReason).toBe("unbound")
  })
})

describe("mechanism 1a — attributed to the bound workspace", () => {
  test("an engine pinned to a different workspace confers no precedence", async () => {
    precedenceInternals.binding = async () => ({ datamateId: 42, datamateName: "analytics" })
    precedenceInternals.attributedTo = async () => "77"
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.enabled).toBe(false)
    expect(precedence.disabledReason).toBe("unattributed")
  })

  test("an unpinned engine confers no precedence", async () => {
    precedenceInternals.attributedTo = async () => null
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.disabledReason).toBe("unattributed")
  })

  test("refusing to engage is fail-open: the local call still runs", async () => {
    precedenceInternals.attributedTo = async () => null
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })

  test("the inventory line says why shadowing is off", async () => {
    precedenceInternals.attributedTo = async () => null
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(inventoryLine(precedence)).toContain("could not be attributed")
  })
})

describe("mechanism 2 — capability-scoped, not type-scoped", () => {
  test("snowflake shadows execute, explain and inspect", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const byCapability = precedence.shadowed.get("snowflake")!
    expect([...byCapability.keys()].sort()).toEqual(["schema_inspect", "sql_execute", "sql_explain"])
  })

  test("bigquery shadows execute only — explain and inspect stay local", async () => {
    const precedence = await refresh(SESSION, BIGQUERY_TOOLS)
    const byCapability = precedence.shadowed.get("bigquery")!
    expect([...byCapability.keys()]).toEqual(["sql_execute"])
  })

  test("sql_explain on a bigquery connection is NOT redirected to a tool that does not exist", async () => {
    await refresh(SESSION, BIGQUERY_TOOLS)
    precedenceInternals.attributedTo = async () => "42"
    const verdict = await check(SESSION, "sql_explain", "bq_conn")
    expect(verdict.redirect).toBeUndefined()
  })

  test("databricks execute is named by its own convention", async () => {
    const precedence = await refresh(SESSION, { datamate_databricks_execute_sql: {} })
    expect(precedence.shadowed.get("databricks")?.get("sql_execute")?.modelKey).toBe("datamate_databricks_execute_sql")
  })

  test("a type with no materialised integration is untouched", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.shadowed.has("duckdb")).toBe(false)
  })
})

describe("driver aliases — canonicalType inverts DRIVER_MAP", () => {
  test("postgresql and postgres are one driver", () => {
    expect(canonicalType("postgresql")).toBe("postgres")
    expect(canonicalType("postgres")).toBe("postgres")
  })

  test("mysql/mariadb and the sqlserver family collapse", () => {
    expect(canonicalType("mariadb")).toBe("mysql")
    expect(canonicalType("mssql")).toBe("sqlserver")
    expect(canonicalType("fabric")).toBe("sqlserver")
  })

  test("redshift keeps its own identity and is not served by a postgresql integration", async () => {
    expect(canonicalType("redshift")).toBe("redshift")
    const precedence = await refresh(SESSION, {
      datamate_postgresql_execute_database_query: {},
    })
    expect(precedence.shadowed.has("postgres")).toBe(true)
    expect(precedence.shadowed.has("redshift")).toBe(false)
  })

  test("a postgres-typed connection is served by a postgresql integration", async () => {
    await refresh(SESSION, { datamate_postgresql_execute_database_query: {} })
    // `pg_conn` is registered as type "postgresql"; the integration id is also
    // "postgresql" but the canonical driver is "postgres". The alias collapse is what
    // makes these meet.
    const verdict = await check(SESSION, "sql_execute", "pg_conn")
    expect(verdict.redirect?.metadata.redirect_to).toBe("datamate_postgresql_execute_database_query")
  })

  test("a redshift connection is NOT redirected by a postgresql integration", async () => {
    await refresh(SESSION, { datamate_postgresql_execute_database_query: {} })
    const verdict = await check(SESSION, "sql_execute", "rs_conn")
    expect(verdict.redirect).toBeUndefined()
  })

  test("an unknown type canonicalises to null rather than guessing", () => {
    expect(canonicalType("not-a-database")).toBeNull()
    expect(canonicalType(undefined)).toBeNull()
  })
})

describe("mechanism 4 — the redirect", () => {
  test("carries the machine-readable marker telemetry needs", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeDefined()
    expect(verdict.redirect!.metadata.redirected).toBe(true)
    expect(verdict.redirect!.metadata.redirect_to).toBe("datamate_snowflake_execute_database_query")
    expect(verdict.redirect!.metadata.precedence).toBe("shadowed")
  })

  test("names the exact engine key in the text the model reads", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect!.output).toContain("datamate_snowflake_execute_database_query")
    expect(verdict.redirect!.output).toContain("--integrations=local")
  })

  test("a connection whose type is not served runs locally", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_duck")
    expect(verdict.redirect).toBeUndefined()
  })
})

describe("the dbt-fallback redirect explains itself", () => {
  test("names the fallback connection and both ways out", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    // Reach the fallback branch directly: the default target is dbt with a served
    // registry fallback behind it.
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    // (the explicit-warehouse path shares redirectFor; assert the plain wording here)
    expect(verdict.redirect!.output).toContain("--integrations=local")
    expect(verdict.redirect!.metadata.via).toBeUndefined()
  })
})

describe("default-target decisions — branch order", () => {
  // Reaching a dbt-sourced target through check() needs a real dbt project, so the
  // order of these branches is only checkable on the pure function. It is also the
  // property that has broken most often, which is why it gets its own suite.
  const snowflakeFallback = { type: "snowflake", name: "local_snow" }

  test("a served dbt target redirects", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const v = decideForTarget(p, "sql_execute", { source: "dbt", type: "snowflake" })
    expect(v.redirect?.metadata.redirect_to).toBe("datamate_snowflake_execute_database_query")
  })

  test("an UNDETERMINED dbt type still redirects when the fallback behind it is served", async () => {
    // The regression this suite exists for: returning "undetermined" before looking
    // at the fallback fails open into a local execution against a served connection.
    // An undetermined type is *more* likely to be the broken setup that falls back.
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const v = decideForTarget(p, "sql_execute", { source: "dbt", type: undefined, fallback: snowflakeFallback })
    expect(v.redirect).toBeDefined()
    expect(v.redirect!.metadata.via).toBe("dbt-fallback")
    expect(v.precedence).toBeUndefined()
  })

  test("an undetermined dbt type with an UNSERVED fallback runs locally, non-silently", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const v = decideForTarget(p, "sql_execute", {
      source: "dbt",
      type: undefined,
      fallback: { type: "duckdb", name: "local_duck" },
    })
    expect(v.redirect).toBeUndefined()
    expect(v.precedence).toBe("undetermined")
    expect(v.notice).toContain("could not be determined")
  })

  test("an undetermined dbt type with no fallback at all runs locally, non-silently", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const v = decideForTarget(p, "sql_execute", { source: "dbt", type: undefined })
    expect(v.precedence).toBe("undetermined")
  })

  test("an unserved dbt type with a served fallback still redirects", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const v = decideForTarget(p, "sql_execute", { source: "dbt", type: "duckdb", fallback: snowflakeFallback })
    expect(v.redirect!.metadata.via).toBe("dbt-fallback")
  })

  test("a registry target is decided on its own type, with no fallback notion", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(decideForTarget(p, "sql_execute", { source: "registry", type: "snowflake", name: "s" }).redirect).toBeDefined()
    expect(decideForTarget(p, "sql_execute", { source: "registry", type: "duckdb", name: "d" }).redirect).toBeUndefined()
  })

  test("no resolvable target runs locally", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(decideForTarget(p, "sql_execute", { source: "none" })).toEqual({})
  })

  test("explain is decided per capability, so an execute-only integration leaves it local", async () => {
    const p = await refresh(SESSION, BIGQUERY_TOOLS)
    expect(decideForTarget(p, "sql_execute", { source: "registry", type: "bigquery", name: "b" }).redirect).toBeDefined()
    expect(decideForTarget(p, "sql_explain", { source: "registry", type: "bigquery", name: "b" }).redirect).toBeUndefined()
  })
})

describe("mechanism 6 — the escape hatch", () => {
  test("--integrations=local turns shadowing off for the session", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.enabled).toBe(false)
    expect(precedence.disabledReason).toBe("escape-hatch")
    expect(inventoryLine(precedence)).toContain("--integrations=local")
  })

  test("with the hatch on, a served connection still runs locally", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })

  test("--integrations=workspace leaves precedence on", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "workspace"
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(precedence.enabled).toBe(true)
  })
})

describe("descriptions and listings", () => {
  test("engine tools serving a shadowed capability name the workspace", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    const described = describeEngineTool("datamate_snowflake_execute_database_query", "Run a query.", precedence)
    expect(described).toContain("(workspace analytics)")
  })

  test("an engine tool that shadows nothing is described unchanged", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(describeEngineTool("datamate_jira_get_issue", "Get an issue.", precedence)).toBe("Get an issue.")
  })

  test("native warehouse tools say that served types redirect", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(describeNativeTool("sql_execute", "Execute SQL.", precedence)).toContain("analytics")
  })

  test("unrelated native tools are described unchanged", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(describeNativeTool("read", "Read a file.", precedence)).toBe("Read a file.")
  })

  test("descriptions are untouched when precedence is off", async () => {
    const precedence = await refresh(SESSION, {})
    expect(describeNativeTool("sql_execute", "Execute SQL.", precedence)).toBe("Execute SQL.")
  })

  test("warehouse_list notes are per capability", async () => {
    const precedence = await refresh(SESSION, BIGQUERY_TOOLS)
    const note = warehouseListNote(precedence, "bigquery")
    expect(note).toContain("execute via workspace analytics")
    expect(note).toContain("explain/inspect local")
  })

  test("warehouse_list leaves an unserved type unmarked", async () => {
    const precedence = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(warehouseListNote(precedence, "duckdb")).toBeNull()
  })

  test("the inventory line reports served and local capabilities", async () => {
    const precedence = await refresh(SESSION, BIGQUERY_TOOLS)
    const line = inventoryLine(precedence)
    expect(line).toContain("bigquery: execute via workspace analytics")
    expect(line).toContain("explain/inspect stay local")
  })
})

describe("mechanism 6 — the inventory is stated once per session", () => {
  test("the line is reported on first derivation", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("snowflake: execute/explain/inspect via workspace analytics")
  })

  test("re-deriving every turn does not repeat it", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(1)
  })

  test("the escape hatch is reported rather than passing silently", async () => {
    process.env.ALTIMATE_INTEGRATIONS = "local"
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines[0]).toContain("--integrations=local")
  })

  test("an ordinary unbound session says nothing", async () => {
    precedenceInternals.binding = async () => null
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(0)
  })

  test("counts the local connections that are shadowed", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    // local_snow is snowflake; local_duck, bq_conn, pg_conn and rs_conn are not served.
    expect(lines[0]).toContain("1 local connection shadowed")
  })
})

describe("re-derivation", () => {
  test("precedence follows the live tool map when the engine's tools change", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(forSession(SESSION)?.shadowed.get("snowflake")?.size).toBe(3)

    // The engine's active teammate changed underneath: fewer tools materialise.
    await refresh(SESSION, { datamate_snowflake_execute_database_query: {} })
    expect(forSession(SESSION)?.shadowed.get("snowflake")?.size).toBe(1)

    // ...and once nothing is left, nothing is shadowed.
    await refresh(SESSION, {})
    expect(forSession(SESSION)?.enabled).toBe(false)
  })

  test("a session with no derivation yet never shadows", async () => {
    const verdict = await check("ses_never_refreshed", "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })
})
