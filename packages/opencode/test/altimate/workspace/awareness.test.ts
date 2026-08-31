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
// altimate_change - shared with precedence.test.ts; see precedence-fixture.ts
import { ANALYST_RULESET, BIGQUERY_TOOLS, SNOWFLAKE_TOOLS, WAREHOUSE_CONFIGS, bindTo } from "./precedence-fixture"

const SESSION = "ses_awareness"
const ORIGINAL_INTEGRATIONS = process.env.ALTIMATE_INTEGRATIONS
const ORIGINAL_PILOT = process.env.ALTIMATE_WORKSPACE

/** Render whatever the session's current snapshot says, the way prompt.ts does. */
const section = () => systemSection(forSession(SESSION))

beforeEach(() => {
  resetForTests()
  delete process.env.ALTIMATE_INTEGRATIONS
  process.env.ALTIMATE_WORKSPACE = "1"
  bindTo()
  Registry.setConfigs({ ...WAREHOUSE_CONFIGS })
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
    // Rationale lives on ESCAPE_HATCH_SECTION in awareness.ts.
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
    // Rationale lives on `assemble` in awareness.ts.
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
    await refresh(SESSION, SNOWFLAKE_TOOLS, ANALYST_RULESET)
    expect(section()).toBe("")
  })
})

describe("the size ceiling", () => {
  test("stays under the cap and degrades by dropping whole types", async () => {
    // Rationale lives on MAX_SECTION_CHARS in awareness.ts. Synthesised to exercise
    // the truncation path, which real engines do not reach today.
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
  // assemble exactly the system prompt it did before this module existed.

  test("every disabled reason is decided explicitly, and only the hatch speaks", () => {
    // A `Record` over the union, NOT an array of it: `Reason[]` would accept a short
    // list, so a sixth reason would compile and silently render "". The Record is
    // exhaustiveness-checked, so this table is the compile-time decision point.
    const speaks: Record<NonNullable<Precedence["disabledReason"]>, boolean> = {
      "pilot-off": false,
      "escape-hatch": true,
      unbound: false,
      "binding-unreadable": false,
      unattributed: false,
      "derive-failed": false,
      "nothing-materialised": false,
    }
    for (const [reason, expected] of Object.entries(speaks)) {
      const snapshot: Precedence = {
        workspaceName: "analytics",
        enabled: false,
        disabledReason: reason as NonNullable<Precedence["disabledReason"]>,
        shadowed: new Map(),
      }
      const out = systemSection(snapshot)
      expect(out.includes("--integrations=local")).toBe(expected)
      if (!expected) expect(out).toBe("")
    }
  })

  test("contributes a section only once the workspace is really routing", async () => {
    // Mirrors the spread in prompt.ts. The "" cases are covered above and in the
    // silence suite; what needs proving here is that the section is not inert — a
    // routing session must actually add an element.
    const assemble = (section: string) => ["environment", "skills", ...(section ? [section] : []), "instructions"]
    await refresh(SESSION, SNOWFLAKE_TOOLS)
    expect(assemble(section())).toHaveLength(4)
    expect(assemble(section())[2]).toContain("## Workspace integrations")
  })
})
