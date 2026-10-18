// altimate_change start — bounded re-run evidence for answer_commit, against real scratch DuckDB and SQLite
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { initTool } from "../tool-fixture"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { closeScratch, getScratch, withScratchSession } from "../../../src/altimate/native/connections/scratch"
import { AnswerCommit } from "../../../src/altimate/tools/answer-commit"
import {
  alternativeColumns,
  compareReadings,
  gatherEvidence,
  REVIEW_MARKER,
  vacuousFilters,
} from "../../../src/altimate/tools/answer-commit-evidence"

const setup = [
  "CREATE TABLE orders (id INTEGER, status TEXT, region TEXT, note TEXT, created_at DATE, shipped_at DATE)",
  `INSERT INTO orders VALUES
    (1, 'open', 'EU', 'a', DATE '2023-04-02', DATE '2023-05-01'),
    (2, 'open', 'EU', 'b', DATE '2023-04-15', DATE '2023-04-20'),
    (3, 'closed', 'EU', 'c', DATE '2023-03-30', DATE '2023-04-03'),
    (4, 'open', 'EU', NULL, DATE '2023-05-10', DATE '2023-05-12')`,
  "CREATE TABLE customers (id INTEGER, name TEXT)",
  "INSERT INTO customers VALUES (1, 'x'), (2, 'y'), (3, 'z'), (4, 'w')",
  "CREATE TABLE big AS SELECT range AS id FROM range(600000)",
  "CREATE TABLE wide AS SELECT range AS id FROM range(2000)",
]

let fixture: Awaited<ReturnType<typeof tmpdir>>
let sqlitePath: string
let previousFlag: string | undefined

beforeAll(async () => {
  fixture = await tmpdir()
  sqlitePath = path.join(fixture.path, "orders.sqlite")
  const sqlite = new Database(sqlitePath)
  sqlite.run("CREATE TABLE orders (id INTEGER, region TEXT)")
  sqlite.run("INSERT INTO orders VALUES (1, 'EU')")
  sqlite.close()
})

beforeEach(async () => {
  previousFlag = process.env.ALTIMATE_SQL_AUTO_CHECK
  delete process.env.ALTIMATE_SQL_AUTO_CHECK
  Registry.setConfigs({ sqlite_orders: { type: "sqlite", path: sqlitePath } })
  await closeScratch()
  // Only the committing session's scratch store holds the tables, so a check that reads another store finds nothing.
  const duckdb = await getScratch("test-session")
  for (const sql of setup) await duckdb.execute(sql, undefined, undefined, { noLimit: true })
})

afterEach(async () => {
  if (previousFlag === undefined) delete process.env.ALTIMATE_SQL_AUTO_CHECK
  else process.env.ALTIMATE_SQL_AUTO_CHECK = previousFlag
  await Registry.closeAll()
})

afterAll(async () => {
  await closeScratch()
  await fixture?.[Symbol.asyncDispose]()
})

const queryPart = (query: string, warehouse = "scratch") => ({
  type: "tool",
  tool: "sql_execute",
  state: { status: "completed", input: { query, warehouse }, output: "ok" },
})
const turn = (...parts: unknown[]) =>
  [
    { info: { role: "user" }, parts: [] },
    { info: { role: "assistant" }, parts },
  ] as never

/** Direct helper calls run inside the session, as answer_commit runs them. */
const inSession = (name: string, body: () => Promise<void>) => test(name, () => withScratchSession("test-session", body))

const basis = "Counted orders at order grain using orders.id."
const context = (messages: unknown) => ({
  sessionID: "test-session",
  messageID: "test-message",
  agent: "analyst",
  abort: new AbortController().signal,
  messages,
})

describe("vacuous filters", () => {
  inSession("flags a filter that removes no rows and keeps the effective one", async () => {
    const found = await vacuousFilters("SELECT COUNT(*) FROM orders WHERE status = 'open' AND region = 'EU'", "scratch")
    expect(found).toHaveLength(1)
    expect(found![0]!.filter).toContain("region")
    expect(found![0]!.rows).toBe(3)
  })

  inSession("reports nothing when every filter removes rows", async () => {
    expect(await vacuousFilters("SELECT id FROM orders WHERE status = 'open' AND id < 4", "scratch")).toEqual([])
  })

  inSession("skips IS NOT NULL guards and counts before GROUP BY", async () => {
    expect(
      await vacuousFilters(
        "SELECT status, COUNT(*) FROM orders WHERE id IS NOT NULL AND id < 3 GROUP BY status",
        "scratch",
      ),
    ).toEqual([])
  })

  inSession("skips SQLite, large tables, subqueries and joins without a condition", async () => {
    expect(await vacuousFilters("SELECT * FROM orders WHERE region = 'EU'", "sqlite_orders")).toBeUndefined()
    expect(await vacuousFilters("SELECT COUNT(*) FROM big WHERE id >= 0", "scratch")).toBeUndefined()
    expect(
      await vacuousFilters("SELECT * FROM orders WHERE id IN (SELECT id FROM customers) AND region = 'EU'", "scratch"),
    ).toBeUndefined()
    expect(
      await vacuousFilters("SELECT * FROM orders o, customers c WHERE o.id = c.id AND o.region = 'EU'", "scratch"),
    ).toBeUndefined()
    expect(
      await vacuousFilters(
        "WITH huge AS (SELECT * FROM orders) SELECT COUNT(*) FROM huge WHERE status = 'open' AND region = 'EU'",
        "scratch",
      ),
    ).toBeUndefined()
  })

  inSession("skips a join whose row count passes the cap", async () => {
    expect(
      await vacuousFilters("SELECT COUNT(*) FROM wide a JOIN wide b ON a.id <= b.id WHERE a.id >= 0", "scratch"),
    ).toBeUndefined()
  })

  inSession("checks an inner join with a condition", async () => {
    const found = await vacuousFilters(
      "SELECT c.name FROM orders o JOIN customers c ON o.id = c.id WHERE o.region = 'EU' AND o.status = 'open'",
      "scratch",
    )
    expect(found?.map((f) => f.filter.includes("region"))).toEqual([true])
  })
})

describe("readings", () => {
  inSession("compares readings with SQL as unordered row sets", async () => {
    const agree = await compareReadings(
      [
        { clause: "open", reading: "status", sql: "SELECT id FROM orders WHERE status = 'open' ORDER BY id" },
        { clause: "open", reading: "status desc", sql: "SELECT id FROM orders WHERE status = 'open' ORDER BY id DESC" },
      ],
      "scratch",
    )
    expect(agree).toEqual({ compared: 2, agree: true })
    const disagree = await compareReadings(
      [
        { clause: "April", reading: "created", sql: "SELECT id FROM orders WHERE month(created_at) = 4" },
        { clause: "April", reading: "shipped", sql: "SELECT id FROM orders WHERE month(shipped_at) = 4" },
      ],
      "scratch",
    )
    expect(disagree).toEqual({ compared: 2, agree: false })
  })

  inSession("keeps NULL, text and numbers distinct", async () => {
    const pair = (a: string, b: string) =>
      compareReadings(
        [
          { clause: "x", reading: "a", sql: `SELECT ${a} AS v FROM orders WHERE id = 1` },
          { clause: "x", reading: "b", sql: `SELECT ${b} AS v FROM orders WHERE id = 1` },
        ],
        "scratch",
      )
    expect(await pair("CAST(NULL AS TEXT)", "'null'")).toEqual({ compared: 2, agree: false })
    expect(await pair("1", "'1'")).toEqual({ compared: 2, agree: false })
  })

  inSession("does not compare fewer than two runnable readings or unsafe ones", async () => {
    expect(await compareReadings([{ clause: "a", reading: "b", sql: "SELECT 1" }], "scratch")).toBeUndefined()
    expect(
      await compareReadings(
        [
          { clause: "a", reading: "b", sql: "SELECT COUNT(*) FROM big" },
          { clause: "a", reading: "c", sql: "SELECT COUNT(*) FROM orders" },
        ],
        "scratch",
      ),
    ).toBeUndefined()
    expect(
      await compareReadings(
        [
          { clause: "a", reading: "b", sql: "SELECT * FROM orders", warehouse: "sqlite_orders" },
          { clause: "a", reading: "c", sql: "SELECT * FROM orders", warehouse: "sqlite_orders" },
        ],
        "scratch",
      ),
    ).toBeUndefined()
  })

  inSession("lists other date-like columns of the tables the query filters", async () => {
    const lines = await alternativeColumns("SELECT COUNT(*) FROM orders WHERE month(created_at) = 4", "scratch")
    expect(lines).toEqual(["orders: uses created_at; other date-like columns: shipped_at"])
  })
})

describe("answer_commit review", () => {
  const commit = { fields: [{ name: "", value: 3 }], basis }

  test("rejects once with the vacuous filter, then accepts the same answer", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const sql = "SELECT COUNT(*) FROM orders WHERE status = 'open' AND region = 'EU'"
    const first = await tool.execute(commit, context(turn(queryPart(sql))))
    expect(first.status).toBe("error")
    expect(first.output).toContain(REVIEW_MARKER)
    expect(first.output).toContain("removed 0 of the 3 rows")
    const rejected = {
      type: "tool",
      tool: "answer_commit",
      state: { status: "error", input: commit, error: first.output },
    }
    const second = await tool.execute(commit, context(turn(queryPart(sql), rejected)))
    expect(second.status).not.toBe("error")
    expect(second.output).toContain("**Answer:** 3")
  })

  test("commits directly when the filters all remove rows", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const result = await tool.execute(
      { fields: [{ name: "", value: 2 }], basis },
      context(turn(queryPart("SELECT COUNT(*) FROM orders WHERE status = 'open' AND id < 4"))),
    )
    expect(result.status).not.toBe("error")
  })

  test("asks for reading evidence when readings disagree, and accepts it", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const readings = [
      {
        clause: "in April",
        reading: "created in April",
        result_summary: "2",
        decided_by: "creation is when an order exists",
        sql: "SELECT id FROM orders WHERE month(created_at) = 4",
      },
      {
        clause: "in April",
        reading: "shipped in April",
        result_summary: "2",
        decided_by: "rejected",
        sql: "SELECT id FROM orders WHERE month(shipped_at) = 4",
      },
    ]
    const messages = turn(queryPart("SELECT COUNT(*) FROM orders WHERE month(created_at) = 4"))
    const asked = await tool.execute({ ...commit, readings }, context(messages))
    expect(asked.status).toBe("error")
    expect(asked.output).toContain("reading_evidence")
    expect(asked.output).toContain("other date-like columns: shipped_at")
    const accepted = await tool.execute(
      { ...commit, readings, reading_evidence: "Orders are counted by the month they were created." },
      context(messages),
    )
    expect(accepted.status).not.toBe("error")
    expect(accepted.metadata.evidence).toMatchObject({ readings: { compared: 2, agree: false } })
  })

  test("records agreeing readings without a review", async () => {
    const evidence = await gatherEvidence("test-session", turn(queryPart("SELECT id FROM orders WHERE id < 3")), [
      { clause: "a", reading: "b", sql: "SELECT id FROM orders WHERE id < 3" },
      { clause: "a", reading: "c", sql: "SELECT id FROM orders WHERE id IN (1, 2)" },
    ])
    expect(evidence?.readings).toEqual({ compared: 2, agree: true })
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const result = await tool.execute(
      {
        fields: [{ name: "", value: 2 }],
        basis,
        readings: [
          { clause: "a", reading: "b", result_summary: "2", decided_by: "x", sql: "SELECT id FROM orders WHERE id < 3" },
          {
            clause: "a",
            reading: "c",
            result_summary: "2",
            decided_by: "y",
            sql: "SELECT id FROM orders WHERE id IN (1, 2)",
          },
        ],
      },
      context(turn(queryPart("SELECT id FROM orders WHERE id < 3"))),
    )
    expect(result.status).not.toBe("error")
    expect(result.metadata.evidence).toMatchObject({ readings: { agree: true } })
  })

  test("reads the committing session's scratch store", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const sql = "SELECT COUNT(*) FROM orders WHERE status = 'open' AND region = 'EU'"
    expect(await gatherEvidence("other-session", turn(queryPart(sql)), undefined)).toBeUndefined()
    const other = await tool.execute(commit, { ...context(turn(queryPart(sql))), sessionID: "other-session" })
    expect(other.status).not.toBe("error")
  })

  test("does nothing when ALTIMATE_SQL_AUTO_CHECK=off or the query ran on SQLite", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const sql = "SELECT COUNT(*) FROM orders WHERE status = 'open' AND region = 'EU'"
    process.env.ALTIMATE_SQL_AUTO_CHECK = "off"
    expect((await tool.execute(commit, context(turn(queryPart(sql))))).status).not.toBe("error")
    delete process.env.ALTIMATE_SQL_AUTO_CHECK
    const sqlite = await tool.execute(
      commit,
      context(turn(queryPart("SELECT COUNT(*) FROM orders WHERE region = 'EU'", "sqlite_orders"))),
    )
    expect(sqlite.status).not.toBe("error")
  })
})
// altimate_change end
