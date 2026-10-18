import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch, getScratch, withScratchSession } from "../../../src/altimate/native/connections/scratch"
import {
  JOIN_CHECK_BUDGET_MS,
  autoCheckMode,
  coverageLoss,
  joinCoverageNote,
} from "../../../src/altimate/tools/sql-join-coverage"

// 8 cohort members; only ids 1 and 2 have fact rows (2 of 8 = 25% kept).
const statements = [
  'CREATE TABLE cohort ("MemberId" INTEGER, grp TEXT)',
  "INSERT INTO cohort VALUES (1, 'a'), (2, 'a'), (3, 'a'), (4, 'b'), (5, 'b'), (6, 'b'), (7, 'c'), (8, 'c')",
  'CREATE TABLE facts ("MemberId" INTEGER, grp TEXT, v REAL)',
  "INSERT INTO facts VALUES (1, 'a', 1.0), (1, 'a', 2.0), (2, 'a', 3.0)",
  // 4 of 8 cohort members (50%) have a match: at the threshold, no note.
  'CREATE TABLE half_facts ("MemberId" INTEGER)',
  "INSERT INTO half_facts VALUES (1), (2), (3), (4)",
]
const session = "join-coverage-session"
const env = (mode?: string) => (mode === undefined ? {} : { ALTIMATE_SQL_AUTO_CHECK: mode })
const inScratch = <T>(fn: () => Promise<T>) => withScratchSession(session, fn)

let fixture: Awaited<ReturnType<typeof tmpdir>>
let sqlitePath: string

beforeAll(async () => {
  fixture = await tmpdir()
  sqlitePath = path.join(fixture.path, "join-coverage.sqlite")
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

for (const warehouse of ["scratch", "sqlite_local"] as const) {
  describe(`joinCoverageNote on ${warehouse}`, () => {
    test("inner join keeping under half leads with the counts", async () => {
      const note = await inScratch(() =>
        joinCoverageNote(
          'SELECT c."MemberId", AVG(f.v) FROM cohort c JOIN facts f ON c."MemberId" = f."MemberId" GROUP BY 1',
          warehouse,
          {},
          env(),
        ),
      )
      expect(note).toContain("join cohort → facts on MemberId = MemberId")
      expect(note).toContain(
        "WARNING coverage loss: 6 of 8 left rows (75.0%) have no match; the inner join drops them.",
      )
    })

    test("left join uses NULL-row wording and multi-key conditions", async () => {
      const note = await inScratch(() =>
        joinCoverageNote(
          "SELECT * FROM cohort c LEFT JOIN facts f ON f.MemberId = c.MemberId AND c.grp = f.grp",
          warehouse,
          {},
          env(),
        ),
      )
      expect(note).toContain("on MemberId = MemberId, grp = grp")
      expect(note).toContain("they stay as unmatched rows with NULL right columns")
    })

    test("half or more matched, no join, off flag and non-equality conditions stay silent", async () => {
      const cases: [string, string | undefined][] = [
        ["SELECT * FROM cohort c JOIN half_facts h ON c.MemberId = h.MemberId", undefined],
        ["SELECT * FROM cohort WHERE grp = 'a'", undefined],
        ["SELECT * FROM cohort c JOIN facts f ON c.MemberId = f.MemberId", "off"],
        ["SELECT * FROM cohort c JOIN facts f ON c.MemberId < f.MemberId", undefined],
        ["SELECT * FROM cohort c JOIN facts f ON c.MemberId = f.MemberId OR c.grp = f.grp", undefined],
        ["SELECT * FROM cohort c JOIN facts f USING (MemberId)", undefined],
        ["SELECT * FROM cohort c JOIN facts f ON MemberId = v", undefined],
      ]
      for (const [sql, mode] of cases) {
        expect(await inScratch(() => joinCoverageNote(sql, warehouse, {}, env(mode)))).toBeUndefined()
      }
    })
  })
}

describe("joinCoverageNote DuckDB-only shapes", () => {
  test("subqueries and CTEs on scratch are counted as written", async () => {
    const note = await inScratch(() =>
      joinCoverageNote(
        `WITH members AS (SELECT * FROM cohort WHERE grp IN ('a', 'b'))
         SELECT * FROM members m JOIN (SELECT * FROM facts WHERE v > 0) f ON m.MemberId = f.MemberId`,
        "scratch",
        {},
        env(),
      ),
    )
    // 6 members in groups a/b; ids 1 and 2 match.
    expect(note).toContain("WARNING coverage loss: 4 of 6 left rows (66.7%) have no match")
  })

  test("SQLite skips subquery sides instead of guessing", async () => {
    const note = await inScratch(() =>
      joinCoverageNote(
        "SELECT * FROM cohort c JOIN (SELECT * FROM facts) f ON c.MemberId = f.MemberId",
        "sqlite_local",
        {},
        env(),
      ),
    )
    expect(note).toBeUndefined()
  })
})

describe("joinCoverageNote policy and failure paths", () => {
  test("local mode never touches a remote warehouse", async () => {
    const started = Date.now()
    const note = await inScratch(() =>
      joinCoverageNote("SELECT * FROM a x JOIN b y ON x.id = y.id", "remote_pg", {}, env()),
    )
    expect(note).toBeUndefined()
    // Skipped before any connection attempt: well under the check budget.
    expect(Date.now() - started).toBeLessThan(JOIN_CHECK_BUDGET_MS)
  })

  test("errors (missing tables, unreachable warehouse) return undefined", async () => {
    expect(
      await inScratch(() => joinCoverageNote("SELECT * FROM nope a JOIN nada b ON a.id = b.id", "scratch", {}, env())),
    ).toBeUndefined()
    expect(
      await inScratch(() => joinCoverageNote("SELECT * FROM a x JOIN b y ON x.id = y.id", "remote_pg", {}, env("all"))),
    ).toBeUndefined()
  })

  test("a slow count is abandoned within the budget", async () => {
    const duckdb = await getScratch(session)
    await duckdb.execute("CREATE TABLE big AS SELECT range AS id FROM range(30000000)", undefined, undefined, {
      noLimit: true,
    })
    const started = Date.now()
    const note = await inScratch(() =>
      joinCoverageNote("SELECT * FROM big a JOIN big b ON a.id = b.id", "scratch", {}, env()),
    )
    expect(note).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(JOIN_CHECK_BUDGET_MS + 200)
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
    const low = await execute.execute(
      { query: "SELECT c.MemberId, f.v FROM cohort c JOIN facts f ON c.MemberId = f.MemberId", warehouse: "scratch" },
      ctx,
    )
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
      const off = await execute.execute(
        { query: "SELECT c.MemberId, f.v FROM cohort c JOIN facts f ON c.MemberId = f.MemberId", warehouse: "scratch" },
        ctx,
      )
      expect(off.output).not.toContain("WARNING coverage loss")
      // The rows themselves are unchanged with the flag on or off.
      expect(off.output.split("\n").filter((l) => /\b[12]\b/.test(l)).length).toBe(
        low.output.split("\n").filter((l) => /\b[12]\b/.test(l) && !l.includes("WARNING")).length,
      )
    } finally {
      if (previous === undefined) delete process.env.ALTIMATE_SQL_AUTO_CHECK
      else process.env.ALTIMATE_SQL_AUTO_CHECK = previous
    }
  })
})
