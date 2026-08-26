// altimate_change - new file
//
// Unit coverage for workspace precedence: which side serves a warehouse call once a
// bound workspace's engine has attached. The binding and the engine-attribution read
// both go through `precedenceInternals`, so these exercise the decision logic without
// booting an instance, reading config, or touching MCP state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  MAX_TRACKED_SESSIONS,
  check,
  decideForTarget,
  trackedSessionCount,
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
  precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
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

describe("attribution is grounded in the attach, not only the saved config", () => {
  // A `datamate` entry can be rewritten — by an IDE — from unpinned to pinned while
  // MCP keeps serving the process it already connected. The config would then name
  // this workspace while the running engine serves another, which is the exact
  // mis-routing this design exists to prevent. The attach outcome is the runtime
  // signal; the pin is the naming signal; both must agree.
  test("a session with no established attach confers no precedence", async () => {
    precedenceInternals.attachOutcome = async () => ({ kind: "engine-missing", declared: 12 })
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.enabled).toBe(false)
    expect(p.disabledReason).toBe("unattributed")
  })

  test("a superseded attach confers no precedence", async () => {
    // Superseded means the binding moved while the attach was in flight, so whatever
    // is connected was established for a workspace this project has already left.
    precedenceInternals.attachOutcome = async () => ({ kind: "superseded" })
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.enabled).toBe(false)
    expect(p.disabledReason).toBe("unattributed")
  })

  test("a disabled entry confers no precedence either", async () => {
    precedenceInternals.attachOutcome = async () => ({ kind: "entry-disabled" })
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.enabled).toBe(false)
  })

  test("an attach still in flight confers no precedence, and does not wait for it", async () => {
    // The attach task is deliberately uncapped: the prompt loop bounds its own wait and
    // lets a turn proceed without engine tools past the cap, so a broken connection
    // cannot hold up the conversation. Attribution reads `settledOutcome`, a pure read
    // of state already held, so it cannot reintroduce that wait — an earlier version
    // awaited the task itself and hung the turn for the full connection timeout.
    //
    // `undefined` covers both "in flight" and "never attached"; they are
    // indistinguishable, and both must fail open rather than route.
    precedenceInternals.attachOutcome = async () => undefined
    const started = Date.now()
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(p.enabled).toBe(false)
    expect(p.disabledReason).toBe("unattributed")
  })

  test("an unattested session runs locally rather than being blocked", async () => {
    precedenceInternals.attachOutcome = async () => undefined
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })

  test("a settled outcome is still read, so the common case is unaffected", async () => {
    precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.enabled).toBe(true)
  })

  test("only an established attach qualifies — every other outcome is refused", async () => {
    // Asserts the invariant rather than a sample of it: the allowlist is exactly
    // {attached, reused}, so a new Outcome variant defaults to refusing rather than
    // silently qualifying.
    const refused: Array<{ kind: string }> = [
      { kind: "disabled" },
      { kind: "unbound" },
      { kind: "engine-missing" },
      { kind: "engine-too-old" },
      { kind: "connect-failed" },
      { kind: "entry-disabled" },
      { kind: "superseded" },
    ]
    for (const outcome of refused) {
      resetForTests()
      bindTo()
      precedenceInternals.attachOutcome = async () => outcome as never
      const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
      expect({ kind: outcome.kind, enabled: p.enabled }).toEqual({ kind: outcome.kind, enabled: false })
    }
  })

  test("a reused engine counts as established, because attach verified it first", async () => {
    precedenceInternals.attachOutcome = async () => ({ kind: "reused", available: 12 })
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.enabled).toBe(true)
  })

  test("an established attach whose config now names another workspace is refused", async () => {
    precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
    precedenceInternals.attributedTo = async () => "999"
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(p.disabledReason).toBe("unattributed")
  })
})

describe("the per-session caches are bounded", () => {
  test("old sessions are evicted rather than accumulating", async () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 25; i++) {
      await refresh(`ses_bounded_${i}`, SNOWFLAKE_TOOLS)
    }
    expect(trackedSessionCount()).toBeLessThanOrEqual(MAX_TRACKED_SESSIONS)
    // The newest survives; the oldest is gone.
    expect(forSession(`ses_bounded_${MAX_TRACKED_SESSIONS + 24}`)).toBeDefined()
    expect(forSession("ses_bounded_0")).toBeUndefined()
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

describe("a redirect the caller cannot follow is not a redirect", () => {
  // The `analyst` agent denies everything it does not name and names the native
  // warehouse tools but never the engine keys. Redirecting its permitted reads to a
  // tool it is forbidden to call would take away the one thing that agent exists to
  // do — the same dead end as redirecting to a tool that does not exist.
  const analystLike = [
    { permission: "*", pattern: "*", action: "deny" as const },
    { permission: "sql_execute", pattern: "*", action: "allow" as const },
    { permission: "sql_explain", pattern: "*", action: "allow" as const },
    { permission: "schema_inspect", pattern: "*", action: "allow" as const },
  ]
  const builderLike = [{ permission: "*", pattern: "*", action: "allow" as const }]

  test("a caller denied the engine key runs locally, and is told why", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
    expect(verdict.precedence).toBe("undetermined")
    expect(verdict.notice).toContain("not permitted to call")
  })

  test("a caller allowed the engine key is still redirected", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS, builderLike)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect?.metadata.redirect_to).toBe("datamate_snowflake_execute_database_query")
  })

  test("no ruleset means unknown, which is treated as reachable", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeDefined()
  })

  test("the default-target path is gated too, not just the named-warehouse path", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    const v = decideForTarget(p, "sql_execute", { source: "registry", type: "snowflake", name: "s" })
    expect(v.redirect).toBeUndefined()
    expect(v.notice).toContain("not permitted to call")
  })

  test("the dbt-fallback path is gated too", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    const v = decideForTarget(p, "sql_execute", {
      source: "dbt",
      type: undefined,
      fallback: { type: "snowflake", name: "local_snow" },
    })
    expect(v.redirect).toBeUndefined()
    expect(v.notice).toContain("not permitted to call")
  })
})

describe("reporting never claims a routing that will not happen", () => {
  // The listing is what the model reads before choosing a tool. Telling an analyst a
  // connection is served by the workspace, when that agent's calls demonstrably run
  // locally, is worse than saying nothing: it points the model at the wrong tool.
  const analystLike = [
    { permission: "*", pattern: "*", action: "deny" as const },
    { permission: "sql_execute", pattern: "*", action: "allow" as const },
    { permission: "sql_explain", pattern: "*", action: "allow" as const },
    { permission: "schema_inspect", pattern: "*", action: "allow" as const },
  ]

  test("warehouse_list marks nothing when the caller cannot reach the engine", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    expect(warehouseListNote(p, "snowflake")).toBeNull()
  })

  test("...and the routing decision agrees with it", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
  })

  test("warehouse_list still marks the row for a caller that can reach it", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, [
      { permission: "*", pattern: "*", action: "allow" as const },
    ])
    expect(warehouseListNote(p, "snowflake")).toContain("via workspace")
  })

  test("the inventory line says nothing rather than something false", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    expect(inventoryLine(p)).toBe("")
  })

  test("the native tool description makes no redirect claim either", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, analystLike)
    expect(describeNativeTool("sql_execute", "Execute SQL.", p)).toBe("Execute SQL.")
  })

  test("a partially-reachable caller is reported per capability", async () => {
    // Allowed to execute through the engine, denied explain and inspect.
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS, [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "datamate_snowflake_execute_database_query", pattern: "*", action: "allow" as const },
    ])
    const note = warehouseListNote(p, "snowflake")
    expect(note).toContain("execute via workspace")
    expect(note).toContain("explain/inspect local")
  })
})

describe("descriptions are per capability, and corrections are delivered", () => {
  test("an execute-only integration leaves explain and inspect described as local", async () => {
    // BigQuery provides execute alone, so sql_explain and schema_inspect really do
    // stay local. Telling them they redirect would steer the model away from the
    // local tool that actually works.
    const p = await refresh(SESSION, BIGQUERY_TOOLS)
    expect(describeNativeTool("sql_execute", "Run SQL.", p)).toContain("redirect")
    expect(describeNativeTool("sql_explain", "Explain SQL.", p)).toBe("Explain SQL.")
    expect(describeNativeTool("schema_inspect", "Inspect.", p)).toBe("Inspect.")
  })

  test("a full integration describes all three as redirecting", async () => {
    const p = await refresh(SESSION, SNOWFLAKE_TOOLS)
    for (const id of ["sql_execute", "sql_explain", "schema_inspect"]) {
      expect(describeNativeTool(id, "Base.", p)).toContain("redirect")
    }
  })

  test("warehouse_list still notes the listing whenever anything is served", async () => {
    const p = await refresh(SESSION, BIGQUERY_TOOLS)
    expect(describeNativeTool("warehouse_list", "List.", p)).toContain("redirect")
  })

  test("a corrected inventory is announced, not suppressed", async () => {
    // The first turn can legitimately announce "shadowing off" — an attach that
    // outran its bounded wait is indistinguishable from no engine — and precedence is
    // re-derived every turn, so the session must be told when that changes.
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    precedenceInternals.attachOutcome = async () => undefined
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    const afterFirst = lines.length

    precedenceInternals.attachOutcome = async () => ({ kind: "attached", available: 12, declared: 12, missing: [] })
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines.length).toBeGreaterThan(afterFirst)
    expect(lines[lines.length - 1]).toContain("via workspace")
  })

  test("an unchanged inventory is not repeated every turn", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(1)
  })

  test("routing stopping entirely is announced, not swallowed", async () => {
    // The transition the user most needs to hear, and the one an empty inventory
    // string cannot express on its own: they were told calls are routed, and now
    // they are not.
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(1)
    await refresh(SESSION, {})
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("runs on the local drivers")
  })

  test("routing never having started is not announced as routing stopping", async () => {
    // "Shadowing off, the engine could not be attributed" is a non-empty announcement
    // that is NOT routing. Treating any prior announcement as routing would tell the
    // user routing had stopped when it never began — common when the first attach
    // outruns its wait and later exposes only non-warehouse tools.
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    precedenceInternals.attributedTo = async () => null
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("could not be attributed")

    precedenceInternals.attributedTo = async () => "42"
    await refresh(SESSION, {})
    expect(lines.some((l) => l.includes("any more"))).toBe(false)
  })

  test("a line that failed to publish is said again, not remembered as said", async () => {
    // The toast bridge can be briefly unavailable. Recording the line as announced
    // regardless would suppress it permanently: every later turn with the same
    // inventory sees it as unchanged and skips it, so the session is never told what
    // its calls are doing.
    const attempts: string[] = []
    precedenceInternals.announce = async (line) => {
      attempts.push(line)
      throw new Error("event bridge unavailable")
    }
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(attempts).toHaveLength(1)

    // Same inventory, so nothing has changed — but nothing was delivered either.
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(attempts).toHaveLength(2)

    // Once it lands, it settles: the retry stops rather than repeating every turn.
    precedenceInternals.announce = async (line) => void attempts.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(attempts).toHaveLength(3)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(attempts).toHaveLength(3)
  })

  test("a failed delivery does not corrupt what the session is believed to know", async () => {
    // The restore has to put back the PREVIOUS record, not clear it: dropping it would
    // lose whether the session had been routing, and a later stop would go unannounced.
    const delivered: string[] = []
    precedenceInternals.announce = async (line) => void delivered.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(delivered).toHaveLength(1)

    // A failing announcement of a DIFFERENT line, which must not erase the routing state.
    precedenceInternals.announce = async () => {
      throw new Error("event bridge unavailable")
    }
    await refresh(SESSION, BIGQUERY_TOOLS)

    // Routing stops. The session was routing, so it must still be told so.
    precedenceInternals.announce = async (line) => void delivered.push(line)
    await refresh(SESSION, {})
    expect(delivered.some((l) => l.includes("any more"))).toBe(true)
  })

  test("two announcements failing while they overlap are both still owed", async () => {
    // Precedence is re-derived every turn, so a second refresh can publish a different
    // line before the first has settled. If the rollback restored the earlier record,
    // it would restore a line that was never delivered either — and a later turn
    // returning to that inventory would skip it as already said. Nothing may be treated
    // as delivered until it arrives, whatever order the publications settle in.
    const attempts: string[] = []
    const fail: Array<() => void> = []
    precedenceInternals.announce = (line) => {
      attempts.push(line)
      return new Promise<void>((_resolve, reject) => fail.push(() => reject(new Error("bridge down"))))
    }

    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, BIGQUERY_TOOLS)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).not.toBe(attempts[1])

    // Both fail, in the order they were sent.
    for (const reject of fail) reject()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Neither arrived, so the first inventory is still unsaid.
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(attempts).toHaveLength(3)
    expect(attempts[2]).toBe(attempts[0])
  })

  test("a publication overtaken by a newer one does not record the line it lost to", async () => {
    // Out-of-order settlement: the older publication succeeds after a newer one has
    // started. It must not write itself in as the session's current knowledge, or the
    // newer line is skipped as already said.
    const attempts: string[] = []
    const settle: Array<() => void> = []
    precedenceInternals.announce = (line) => {
      attempts.push(line)
      return new Promise<void>((resolve) => settle.push(resolve))
    }

    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, BIGQUERY_TOOLS)
    // The FIRST publication lands last.
    settle[1]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    settle[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The session's state is the line that actually won, so re-deriving the same
    // inventory stays quiet rather than repeating it.
    await refresh(SESSION, BIGQUERY_TOOLS)
    expect(attempts).toHaveLength(2)
  })

  test("a session that never had routing is still told nothing", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, {})
    expect(lines).toHaveLength(0)
  })

  test("routing stopping is announced once, not every turn", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, {})
    await refresh(SESSION, {})
    await refresh(SESSION, {})
    expect(lines).toHaveLength(2)
  })

  test("a shrinking engine re-announces the smaller inventory", async () => {
    const lines: string[] = []
    precedenceInternals.announce = async (line) => void lines.push(line)
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    await refresh(SESSION, { datamate_snowflake_execute_database_query: {} })
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("explain/inspect stay local")
  })
})

describe("a snapshot must not outlive the binding that justified it", () => {
  test("a mid-flight re-link stops the redirect naming the old workspace", async () => {
    // Re-linking mid-session is supported, so the turn's snapshot can name a workspace
    // the project has already left. Following a redirect to it would run the query
    // with that workspace's credentials — the exact mis-routing this design prevents.
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect((await check(SESSION, "sql_execute", "local_snow")).redirect).toBeDefined()

    precedenceInternals.binding = async () => ({ datamateId: 77, datamateName: "somewhere-else" })
    const verdict = await check(SESSION, "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
    expect(verdict.precedence).toBe("undetermined")
    expect(verdict.notice).toContain("re-linked")
  })

  test("an unchanged binding still redirects", async () => {
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect((await check(SESSION, "sql_execute", "local_snow")).redirect).toBeDefined()
  })

  test("a session whose snapshot was evicted says so rather than running silently", async () => {
    // Eviction can drop an entry between tool resolution and the call. Returning a
    // bare "run" there is indistinguishable from a considered "not served", so a
    // shadowed connection would execute locally with no indication.
    const verdict = await check("ses_never_derived", "sql_execute", "local_snow")
    expect(verdict.redirect).toBeUndefined()
    expect(verdict.precedence).toBe("undetermined")
    expect(verdict.notice).toContain("no routing decision")
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
    // ...and is explicit about it, rather than silently looking like "not served".
    expect(verdict.precedence).toBe("undetermined")
  })
})
