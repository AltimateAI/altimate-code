import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch, getScratch, withScratchSession } from "../../../src/altimate/native/connections/scratch"
import {
  JOIN_CHECK_BUDGET_MS,
  LOCAL_ROW_CEILING,
  autoCheckMode,
  coverageLoss,
  joinCoverageNote,
} from "../../../src/altimate/tools/sql-join-coverage"

// 8 cohort members; only ids 1 and 2 have fact rows (2 of 8 = 25% kept). NULL keys never match.
const statements = [
  'CREATE TABLE cohort ("MemberId" INTEGER, grp TEXT)',
  "INSERT INTO cohort VALUES (1, 'a'), (2, 'a'), (3, 'a'), (4, 'b'), (5, 'b'), (6, 'b'), (7, 'c'), (NULL, 'c')",
  'CREATE TABLE facts ("MemberId" INTEGER, grp TEXT, v REAL)',
  "INSERT INTO facts VALUES (1, 'a', 1.0), (1, 'a', 2.0), (2, 'a', 3.0), (NULL, 'c', 4.0)",
  // 4 of 8 cohort members (50%) have a match: at the threshold, no note.
  'CREATE TABLE half_facts ("MemberId" INTEGER)',
  "INSERT INTO half_facts VALUES (1), (2), (3), (4)",
]
const session = "join-coverage-session"
const env = (mode?: string) => (mode === undefined ? {} : { ALTIMATE_SQL_AUTO_CHECK: mode })
const inScratch = <T>(fn: () => Promise<T>) => withScratchSession(session, fn)
const lowJoin = 'SELECT c."MemberId", AVG(f.v) FROM cohort c JOIN facts f ON c."MemberId" = f."MemberId" GROUP BY 1'

let fixture: Awaited<ReturnType<typeof tmpdir>>
let sqlitePath: string
let duckdbPath: string

beforeAll(async () => {
  fixture = await tmpdir()
  sqlitePath = path.join(fixture.path, "join-coverage.sqlite")
  duckdbPath = path.join(fixture.path, "join-coverage.duckdb")
  const sqlite = new Database(sqlitePath)
  try {
    for (const sql of statements) sqlite.run(sql)
  } finally {
    sqlite.close()
  }
})

beforeEach(async () => {
  Registry.setConfigs({
    sqlite_local: { type: "sqlite", path: sqlitePath },
    duckdb_local: { type: "duckdb", path: duckdbPath, create: true },
    duckdb_cloud: { type: "duckdb", path: "md:analytics" },
    remote_pg: { type: "postgres", host: "127.0.0.1", port: 1, database: "none", user: "none" },
  })
  await closeScratch()
  const duckdb = await getScratch(session)
  for (const sql of statements) await duckdb.execute(sql, undefined, undefined, { noLimit: true })
})

afterEach(async () => {
  await Registry.closeAll()
})

afterAll(async () => {
  await closeScratch()
  await fixture?.[Symbol.asyncDispose]()
})

describe("autoCheckMode", () => {
  test("defaults to local and accepts off/all", () => {
    expect(autoCheckMode({})).toBe("local")
    expect(autoCheckMode({ ALTIMATE_SQL_AUTO_CHECK: "nonsense" })).toBe("local")
    for (const off of ["off", "0", "false", " OFF "])
      expect(autoCheckMode({ ALTIMATE_SQL_AUTO_CHECK: off })).toBe("off")
    expect(autoCheckMode({ ALTIMATE_SQL_AUTO_CHECK: "all" })).toBe("all")
  })
})

describe("coverageLoss", () => {
  test("warns only below half", () => {
    expect(coverageLoss(2, 8, "left rows", "the inner join drops them")[0]).toMatch(
      /^WARNING coverage loss: 6 of 8 left rows \(75\.0%\) have no match; the inner join drops them\./,
    )
    expect(coverageLoss(4, 8, "left rows", "x")).toEqual([])
    expect(coverageLoss(0, 0, "left rows", "x")).toEqual([])
  })
})

describe("joinCoverageNote on the scratch database", () => {
  test("inner join keeping under half leads with the counts; NULL keys never match", async () => {
    const note = await inScratch(() => joinCoverageNote(lowJoin, "scratch", {}, env()))
    expect(note).toContain("join cohort → facts on MemberId = MemberId")
    expect(note).toContain("WARNING coverage loss: 6 of 8 left rows (75.0%) have no match; the inner join drops them.")
  })

  test("left join wording, multi-key and reversed operands", async () => {
    const note = await inScratch(() =>
      joinCoverageNote(
        "SELECT * FROM cohort c LEFT JOIN facts f ON f.MemberId = c.MemberId AND c.grp = f.grp",
        "scratch",
        {},
        env(),
      ),
    )
    expect(note).toContain("on MemberId = MemberId, grp = grp")
    expect(note).toContain("6 of 8 left rows")
    expect(note).toContain("they stay as unmatched rows with NULL right columns")
  })

  test("stays silent when coverage is fine or the shape is not a plain table equality join", async () => {
    const cases: [string, string | undefined][] = [
      ["SELECT * FROM cohort c JOIN half_facts h ON c.MemberId = h.MemberId", undefined],
      ["SELECT * FROM cohort WHERE grp = 'a'", undefined],
      [lowJoin, "off"],
      ["SELECT * FROM cohort c JOIN facts f ON c.MemberId < f.MemberId", undefined],
      ["SELECT * FROM cohort c JOIN facts f ON c.MemberId = f.MemberId OR c.grp = f.grp", undefined],
      ["SELECT * FROM cohort c JOIN facts f USING (MemberId)", undefined],
      ["SELECT * FROM cohort c JOIN facts f ON MemberId = v", undefined],
      // Subquery sides, CTE names and column alias lists are skipped instead of rebuilt.
      ["SELECT * FROM cohort c JOIN (SELECT * FROM facts) f ON c.MemberId = f.MemberId", undefined],
      [
        "WITH facts AS (SELECT 99 AS MemberId) SELECT * FROM cohort c JOIN facts f ON c.MemberId = f.MemberId",
        undefined,
      ],
      ["SELECT * FROM cohort c(x, y) JOIN facts f ON c.x = f.MemberId", undefined],
      // Parse failures never produce a note.
      ["SELEC broken JOIN", undefined],
    ]
    for (const [sql, mode] of cases) {
      expect(await inScratch(() => joinCoverageNote(sql, "scratch", {}, env(mode)))).toBeUndefined()
    }
  })

  test("views and tables over the size ceiling are not counted, and scratch state survives", async () => {
    const duckdb = await getScratch(session)
    await duckdb.execute("CREATE VIEW cohort_view AS SELECT * FROM cohort", undefined, undefined, { noLimit: true })
    await duckdb.execute(
      `CREATE TABLE big AS SELECT range AS "MemberId" FROM range(${LOCAL_ROW_CEILING + 1000})`,
      undefined,
      undefined,
      { noLimit: true },
    )
    expect(
      await inScratch(() =>
        joinCoverageNote("SELECT * FROM cohort_view c JOIN facts f ON c.MemberId = f.MemberId", "scratch", {}, env()),
      ),
    ).toBeUndefined()
    const started = Date.now()
    expect(
      await inScratch(() =>
        joinCoverageNote("SELECT * FROM big b JOIN facts f ON b.MemberId = f.MemberId", "scratch", {}, env()),
      ),
    ).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(JOIN_CHECK_BUDGET_MS + 200)
    // The engine was never interrupted: earlier tables are still there.
    const rows = await duckdb.execute("SELECT COUNT(*) AS n FROM cohort", undefined, undefined, { noLimit: true })
    expect(Number(rows.rows[0][0])).toBe(8)
  })
})

describe("joinCoverageNote warehouse policy", () => {
  test("a local DuckDB file is checked in local mode", async () => {
    const connector = await Registry.get("duckdb_local")
    for (const sql of statements) await connector.execute(sql, undefined, undefined, { noLimit: true })
    expect(await inScratch(() => joinCoverageNote(lowJoin, "duckdb_local", {}, env()))).toContain("6 of 8 left rows")
  })

  test("SQLite, cloud DuckDB and remote warehouses are skipped in local mode", async () => {
    for (const warehouse of ["sqlite_local", "duckdb_cloud", "remote_pg"]) {
      const started = Date.now()
      expect(await inScratch(() => joinCoverageNote(lowJoin, warehouse, {}, env()))).toBeUndefined()
      // Skipped before any connection attempt.
      expect(Date.now() - started).toBeLessThan(JOIN_CHECK_BUDGET_MS)
    }
  })

  test("all mode never counts SQLite or cloud DuckDB, and an unreachable remote returns undefined", async () => {
    for (const warehouse of ["sqlite_local", "duckdb_cloud", "remote_pg"]) {
      expect(await inScratch(() => joinCoverageNote(lowJoin, warehouse, {}, env("all")))).toBeUndefined()
    }
  })

  test("missing tables return undefined", async () => {
    expect(
      await inScratch(() => joinCoverageNote("SELECT * FROM nope a JOIN nada b ON a.id = b.id", "scratch", {}, env())),
    ).toBeUndefined()
  })
})

describe("sql_execute integration", () => {
  test("the note reaches tool output and metadata only when coverage is low", async () => {
    const { registerAll } = await import("../../../src/altimate/native/connections/register")
    const { SqlExecuteTool } = await import("../../../src/altimate/tools/sql-execute")
    const { MessageID, SessionID } = await import("../../../src/session/schema")
    const { initTool } = await import("../tool-fixture")
    registerAll()
    const execute = await initTool(SqlExecuteTool)
    const ctx = {
      sessionID: SessionID.make("ses_join_coverage_tool"),
      messageID: MessageID.make("msg_join_coverage_tool"),
      agent: "analyst",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => {},
      ask: async () => {},
    }
    const scratch = await getScratch("ses_join_coverage_tool")
    for (const sql of statements) await scratch.execute(sql, undefined, undefined, { noLimit: true })
    const query = "SELECT c.MemberId, f.v FROM cohort c JOIN facts f ON c.MemberId = f.MemberId ORDER BY 1, 2"
    const low = await execute.execute({ query, warehouse: "scratch" }, ctx)
    expect(low.output).toContain("WARNING coverage loss: 6 of 8 left rows (75.0%) have no match")
    expect(low.metadata.join_coverage_warning).toBe(true)
    const ok = await execute.execute(
      { query: "SELECT * FROM cohort c JOIN half_facts h ON c.MemberId = h.MemberId", warehouse: "scratch" },
      ctx,
    )
    expect(ok.output).not.toContain("WARNING coverage loss")
    expect(ok.metadata.join_coverage_warning).toBeUndefined()
    const previous = process.env.ALTIMATE_SQL_AUTO_CHECK
    process.env.ALTIMATE_SQL_AUTO_CHECK = "off"
    try {
      const off = await execute.execute({ query, warehouse: "scratch" }, ctx)
      expect(off.output).not.toContain("WARNING coverage loss")
      // The rows are identical with the check on or off.
      expect(off.metadata.rowCount).toBe(low.metadata.rowCount)
      expect(low.output).toContain(off.output.split("\n")[0])
    } finally {
      if (previous === undefined) delete process.env.ALTIMATE_SQL_AUTO_CHECK
      else process.env.ALTIMATE_SQL_AUTO_CHECK = previous
    }
  })
})
