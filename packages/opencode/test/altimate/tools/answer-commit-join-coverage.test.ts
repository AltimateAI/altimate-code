// altimate_change start — commit-time join-coverage review, against real scratch DuckDB
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { initTool } from "../tool-fixture"
import { closeScratch, getScratch } from "../../../src/altimate/native/connections/scratch"
import { AnswerCommit } from "../../../src/altimate/tools/answer-commit"
import {
  acknowledged,
  committedEvidence,
  finalQuery,
  measureJoins,
  REVIEW_MARKER,
} from "../../../src/altimate/tools/answer-commit-join-coverage"

const SESSION = "join-session"
const setup = [
  // 513 patients, 23 of them with one lab row each.
  "CREATE TABLE patients AS SELECT 'P-' || lpad(i::VARCHAR, 4, '0') AS pid, CASE WHEN i % 2 = 0 THEN 'alpha' ELSE 'beta' END AS cohort FROM range(513) t(i)",
  "CREATE TABLE labs AS SELECT 'P-' || lpad((i * 20)::VARCHAR, 4, '0') AS patient_id, 10.0 + i AS reading FROM range(23) t(i)",
  // The same 23 shared ids stored lower-case with trailing spaces.
  "CREATE TABLE labs_messy AS SELECT lower('P-' || lpad((i * 20)::VARCHAR, 4, '0')) || '  ' AS patient_id, 10.0 + i AS reading FROM range(23) t(i)",
  // Every patient has a measurement.
  "CREATE TABLE measurements AS SELECT pid AS patient_id, 1.5 AS reading FROM patients",
  // 100 customers; 200 orders over 20 customers, all paid.
  "CREATE TABLE customers AS SELECT i AS customer_id, 'r' || (i % 4) AS region FROM range(100) t(i)",
  "CREATE TABLE orders AS SELECT i AS order_id, i % 20 AS customer_id, 'paid' AS status, 5.0 AS amount FROM range(200) t(i)",
  // Fan-out: every row of a joins every row of b.
  "CREATE TABLE fan_a AS SELECT i AS id, 1 AS k FROM range(20000) t(i)",
  "CREATE TABLE fan_b AS SELECT * FROM fan_a",
  // Wide keys: 8 KB strings.
  "CREATE TABLE wide AS SELECT repeat('x', 8192) || i::VARCHAR AS k, i AS n FROM range(1000) t(i)",
  "CREATE TABLE wide_b AS SELECT k FROM wide WHERE n < 100",
  // A table with a pending in-place update: its segment statistics are not merged yet.
  "CREATE TABLE updated AS SELECT 'P-' || lpad(i::VARCHAR, 4, '0') AS pid, 'alpha' AS cohort FROM range(513) t(i)",
  "UPDATE updated SET pid = repeat('y', 9000) WHERE pid = 'P-0001'",
  "CREATE TABLE big AS SELECT 'P-' || i::VARCHAR AS pid, 'alpha' AS cohort FROM range(600000) t(i)",
]

let previousFlag: string | undefined
let previousTimeout: string | undefined

beforeAll(async () => {
  await closeScratch()
  const scratch = await getScratch(SESSION)
  for (const sql of setup) await scratch.execute(sql, undefined, undefined, { noLimit: true })
})

beforeEach(() => {
  previousFlag = process.env.ALTIMATE_SQL_AUTO_CHECK
  previousTimeout = process.env.ALTIMATE_SQL_QUERY_TIMEOUT_MS
  delete process.env.ALTIMATE_SQL_AUTO_CHECK
  delete process.env.ALTIMATE_SQL_QUERY_TIMEOUT_MS
})

afterEach(() => {
  for (const [key, value] of [
    ["ALTIMATE_SQL_AUTO_CHECK", previousFlag],
    ["ALTIMATE_SQL_QUERY_TIMEOUT_MS", previousTimeout],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(async () => {
  await closeScratch()
})

let turnCounter = 0
const queryPart = (query: string, output: string, warehouse = "scratch") => ({
  type: "tool",
  tool: "sql_execute",
  id: `part-${query.length}-${output.length}`,
  state: { status: "completed", input: { query, warehouse }, output },
})
/** A fresh user turn with its own message id. */
const turn = (...parts: unknown[]) =>
  [
    { info: { role: "user", id: `user-${++turnCounter}` }, parts: [] },
    { info: { role: "assistant", id: `assistant-${turnCounter}` }, parts },
  ] as never
const context = (messages: unknown) => ({
  sessionID: SESSION,
  messageID: "test-message",
  agent: "analyst",
  abort: new AbortController().signal,
  messages,
})

const SPARSE_SQL =
  "SELECT p.cohort, avg(l.reading) AS mean_reading FROM patients p JOIN labs l ON l.patient_id = p.pid GROUP BY 1"
const SPARSE_OUTPUT = "cohort | mean_reading\nalpha | 21.0\nbeta | 22.5"
const sparseCommit = {
  rows: {
    columns: ["cohort", "mean_reading"],
    values: [
      ["alpha", 21.0],
      ["beta", 22.5],
    ],
  },
  basis: "Average lab reading per cohort over patients joined to labs.",
}

const measure = (sql: string) => measureJoins(sql, SESSION)

describe("measurement", () => {
  test("sparse measurement table: 23 of 513 patients keep a lab row", async () => {
    const [join] = (await measure(SPARSE_SQL))!
    expect(join).toMatchObject({
      left: { table: "patients", total: 513, matched: 23 },
      right: { table: "labs", total: 23, matched: 23 },
      entity: ["left"],
    })
  })

  test("unqualified keys, wrapped keys with a side filter, comma joins and USING", async () => {
    const unqualified = await measure(
      "SELECT cohort, avg(reading) FROM patients JOIN labs ON pid = patient_id GROUP BY cohort",
    )
    expect(unqualified?.[0]).toMatchObject({ left: { total: 513, matched: 23 } })
    const raw = await measure(
      "SELECT p.cohort, avg(e.reading) FROM patients p JOIN labs_messy e ON e.patient_id = p.pid GROUP BY 1",
    )
    expect(raw?.[0]).toMatchObject({ left: { total: 513, matched: 0 } })
    const wrapped = await measure(
      "SELECT p.cohort, avg(e.reading) FROM patients p JOIN labs_messy e ON upper(trim(e.patient_id)) = p.pid WHERE e.reading IS NOT NULL AND e.reading > 15 GROUP BY 1",
    )
    // Readings 16..32 survive the right-side filter: 17 of the 23 lab rows.
    expect(wrapped?.[0]).toMatchObject({ left: { total: 513, matched: 17 }, right: { total: 17, matched: 17 } })
    const comma = await measure(
      "SELECT p.cohort, count(*) FROM patients p, labs l WHERE p.pid = l.patient_id AND p.cohort = 'alpha' GROUP BY 1",
    )
    // 257 alpha patients (even ids); every lab id is even.
    expect(comma?.[0]).toMatchObject({ left: { total: 257, matched: 23 } })
    const using = await measure(
      "SELECT m.patient_id, avg(m.reading) FROM measurements m JOIN measurements n USING (patient_id) GROUP BY 1",
    )
    expect(using?.[0]).toMatchObject({ left: { total: 513, matched: 513 } })
    const qualified = await measure(
      "SELECT p.cohort, avg(l.reading) FROM scratch.patients p JOIN scratch.labs l ON l.patient_id = p.pid GROUP BY 1",
    )
    expect(qualified?.[0]).toMatchObject({ left: { total: 513, matched: 23 } })
  })

  test("fan-out join is never executed: semi-joins finish quickly", async () => {
    const started = Date.now()
    const [join] = (await measure("SELECT a.id + 100 AS value FROM fan_a a JOIN fan_b b ON a.k = b.k LIMIT 1"))!
    expect(join).toMatchObject({ left: { total: 20000, matched: 20000 }, right: { total: 20000, matched: 20000 } })
    // The 400M-row join takes seconds; the semi-joins take milliseconds.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("skips wide keys, pending updates, large tables and low timeouts", async () => {
    expect(await measure("SELECT count(*) FROM wide w JOIN wide_b v ON w.k = v.k")).toBeUndefined()
    expect(
      await measure("SELECT u.cohort, count(*) FROM updated u JOIN labs l ON l.patient_id = u.pid GROUP BY 1"),
    ).toBeUndefined()
    expect(
      await measure("SELECT b.cohort, count(*) FROM big b JOIN labs l ON l.patient_id = b.pid GROUP BY 1"),
    ).toBeUndefined()
    process.env.ALTIMATE_SQL_QUERY_TIMEOUT_MS = "1000"
    expect(await measure(SPARSE_SQL)).toBeUndefined()
  })

  test("skips outer joins, NULL-safe keys, subqueries, CTEs, non-key filters and unknown functions", async () => {
    for (const sql of [
      "SELECT p.cohort, avg(l.reading) FROM patients p LEFT JOIN labs l ON l.patient_id = p.pid GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id IS NOT DISTINCT FROM p.pid GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid WHERE p.pid IN (SELECT pid FROM patients) GROUP BY 1",
      "WITH x AS (SELECT * FROM patients) SELECT x.cohort, avg(l.reading) FROM x JOIN labs l ON l.patient_id = x.pid GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid WHERE l.reading > length(p.pid) GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON regexp_replace(l.patient_id, 'x', '') = p.pid GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON lpad(l.patient_id, 100000, 'x') = p.pid GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id LIKE '%' || p.pid || '%' GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid AND l.reading = p.cohort AND l.patient_id = p.cohort GROUP BY 1",
      "SELECT p.cohort, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid WHERE l.reading = 9007199254740993 GROUP BY 1",
    ])
      expect(await measure(sql)).toBeUndefined()
  })

  test("a user macro sharing an allowlisted name skips the check", async () => {
    const scratch = await getScratch(SESSION)
    await scratch.execute("CREATE MACRO main.trim(x) AS x", undefined, undefined, { noLimit: true })
    try {
      expect(
        await measure(
          "SELECT p.cohort, avg(e.reading) FROM patients p JOIN labs_messy e ON upper(trim(e.patient_id)) = p.pid GROUP BY 1",
        ),
      ).toBeUndefined()
    } finally {
      await scratch.execute("DROP MACRO main.trim", undefined, undefined, { noLimit: true })
    }
  })

  test("GROUP BY resolution: select alias, rollup, no GROUP BY, and alias collision abstains", async () => {
    expect((await measure("SELECT p.cohort AS c, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid GROUP BY c"))?.[0]?.entity).toEqual(["left"])
    expect((await measure("SELECT p.cohort, l.patient_id, avg(l.reading) FROM patients p JOIN labs l ON l.patient_id = p.pid GROUP BY ROLLUP (1, 2)"))?.[0]?.entity).toEqual(["left", "right"])
    expect((await measure("SELECT count(*) FROM patients p JOIN labs l ON l.patient_id = p.pid"))?.[0]?.entity).toEqual(["left", "right"])
    expect(
      await measure(
        "SELECT avg(o.amount) AS status, o.status FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY status",
      ),
    ).toBeUndefined()
  })

  test("500k x 500k short keys measure well under a second", async () => {
    const scratch = await getScratch(SESSION)
    await scratch.execute(
      "CREATE TABLE p500 AS SELECT 'K-' || lpad(i::VARCHAR, 8, '0') AS k FROM range(500000) t(i)",
      undefined,
      undefined,
      { noLimit: true },
    )
    await scratch.execute(
      "CREATE TABLE q500 AS SELECT lower('K-' || lpad((i * 2)::VARCHAR, 8, '0')) AS k FROM range(500000) t(i)",
      undefined,
      undefined,
      { noLimit: true },
    )
    const started = Date.now()
    const [join] = (await measure("SELECT count(*) FROM p500 p JOIN q500 q ON upper(trim(q.k)) = p.k"))!
    expect(join).toMatchObject({ left: { total: 500000, matched: 250000 } })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("final query location", () => {
  test("picks the query whose output shows the committed values, not the latest query", () => {
    const located = finalQuery(
      turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT), queryPart("SELECT count(*) FROM labs", "count\n23")),
      sparseCommit,
    )
    expect(located?.sql).toBe(SPARSE_SQL)
  })

  test("rounded committed values match; scaled values do not", () => {
    const commit = { fields: [{ value: 21.03 }], basis: "x" }
    expect(finalQuery(turn(queryPart("SELECT 1", "v\n21.0349")), commit)).toBeDefined()
    expect(finalQuery(turn(queryPart("SELECT 1", "v\n0.2103")), commit)).toBeUndefined()
  })

  test("abstains on zero evidence, differing matching queries, truncation and split answers", () => {
    expect(committedEvidence({ fields: [{ value: 5 }] })).toEqual({ numbers: [], strings: [] })
    expect(finalQuery(turn(queryPart(SPARSE_SQL, "5")), { fields: [{ value: 5 }] })).toBeUndefined()
    expect(
      finalQuery(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT), queryPart(`${SPARSE_SQL} ORDER BY 2`, SPARSE_OUTPUT)), sparseCommit),
    ).toBeUndefined()
    expect(
      finalQuery(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT), queryPart(`  ${SPARSE_SQL};`, SPARSE_OUTPUT)), sparseCommit)?.sql,
    ).toBe(`  ${SPARSE_SQL};`)
    expect(
      finalQuery(
        turn(queryPart(SPARSE_SQL, `${SPARSE_OUTPUT}\nThe tool call succeeded but the output was truncated. Full output saved to: /x`)),
        sparseCommit,
      ),
    ).toBeUndefined()
    expect(
      finalQuery(turn(queryPart(SPARSE_SQL, "alpha | 21.0"), queryPart("SELECT 2", "beta | 22.5")), sparseCommit),
    ).toBeUndefined()
  })

  test("acknowledgement needs both numbers", () => {
    expect(acknowledged("kept 23 of 513 patients", 23, 513)).toBe(true)
    expect(acknowledged("23/513 patients", 23, 513)).toBe(true)
    expect(acknowledged("1,023 out of 2,000", 1023, 2000)).toBe(true)
    expect(acknowledged("23 patients", 23, 513)).toBe(false)
    expect(acknowledged("123 of 5130", 23, 513)).toBe(false)
  })
})

describe("answer_commit join review", () => {
  test("rejects once with the measured loss, then accepts the unchanged recommit", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const messages = turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT))
    const first = await tool.execute(sparseCommit, context(messages))
    expect(first.status).toBe("error")
    expect(first.title).toBe("Answer not committed")
    expect(first.output).toBe(
      [
        `${REVIEW_MARKER} not committed yet; check this evidence once.`,
        `- The final query's inner join patients JOIN labs ON (p.pid = l.patient_id) keeps 23 of 513 patients rows (4.5%) after the query's own filters; the other 490 patients rows do not appear in the answer (labs side: 23 of 23 rows match). If the question is about all 513 patients rows, look for a key, column or source that covers them (compare the key formats on both sides; check other tables or ID columns for these entities). If the 23 matched rows are the intended population, state "23 of 513" in basis and call answer_commit again unchanged.`,
        "If the answer stands, call answer_commit again with the same answer; otherwise revise the query first.",
      ].join("\n"),
    )
    expect(first.metadata.evidence.joins[0]).toMatchObject({ fired: true, left: { matched: 23, total: 513 } })
    const rejected = { type: "tool", tool: "answer_commit", state: { status: "error", input: sparseCommit, error: first.output } }
    ;(messages as any)[1].parts.push(rejected)
    const second = await tool.execute(sparseCommit, context(messages))
    expect(second.status).not.toBe("error")
    expect(second.output).toContain("**Answer:**")
  })

  test("customers joined to paid orders fires (documented false-positive class)", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const sql =
      "SELECT c.region, sum(o.amount) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE o.status = 'paid' GROUP BY 1"
    const result = await tool.execute(
      { rows: { columns: ["region", "revenue"], values: [["r0", 250], ["r1", 250]] }, basis: "Paid revenue by region." },
      context(turn(queryPart(sql, "region | revenue\nr0 | 250.0\nr1 | 250.0\nr2 | 250.0\nr3 | 250.0"))),
    )
    expect(result.status).toBe("error")
    expect(result.output).toContain("keeps 20 of 100 customers rows (20.0%)")
  })

  test("full coverage stays silent and commits", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const sql = "SELECT p.cohort, avg(m.reading) FROM patients p JOIN measurements m ON m.patient_id = p.pid GROUP BY 1"
    const result = await tool.execute(
      { rows: { columns: ["cohort", "avg"], values: [["alpha", 1.5], ["beta", 1.5]] }, basis: "All patients." },
      context(turn(queryPart(sql, "cohort | avg\nalpha | 1.5\nbeta | 1.5"))),
    )
    expect(result.status).not.toBe("error")
    expect(result.title).toBe("Answer committed")
  })

  test("stays silent when basis states the loss, the measure side alone lost rows, or the check is off", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const stated = await tool.execute(
      { ...sparseCommit, basis: "Only 23 of 513 patients have a lab reading; averaged over those." },
      context(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT))),
    )
    expect(stated.status).not.toBe("error")
    const measureOnly =
      "SELECT l.patient_id, avg(m.reading) AS r FROM labs l JOIN measurements m ON m.patient_id = l.patient_id GROUP BY 1"
    const silent = await tool.execute(
      { rows: { columns: ["patient_id", "r"], values: [["P-0000", 1.5], ["P-0020", 1.5]] }, basis: "x" },
      context(turn(queryPart(measureOnly, "patient_id | r\nP-0000 | 1.5\nP-0020 | 1.5"))),
    )
    expect(silent.status).not.toBe("error")
    process.env.ALTIMATE_SQL_AUTO_CHECK = "off"
    expect((await tool.execute(sparseCommit, context(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT))))).status).not.toBe(
      "error",
    )
  })

  test("abstains when the committed values have no unique source query or ran outside scratch", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const ambiguous = await tool.execute(
      sparseCommit,
      context(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT), queryPart(`${SPARSE_SQL} ORDER BY 1`, SPARSE_OUTPUT))),
    )
    expect(ambiguous.status).not.toBe("error")
    const zero = await tool.execute(
      { fields: [{ name: "", value: 5 }], basis: "x" },
      context(turn(queryPart("SELECT count(*) FROM patients p JOIN labs l ON l.patient_id = p.pid", "5"))),
    )
    expect(zero.status).not.toBe("error")
    const remote = await tool.execute(sparseCommit, context(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT, "warehouse_a"))))
    expect(remote.status).not.toBe("error")
  })

  test("concurrent commits in one turn get exactly one review", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const messages = turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT))
    const results = await Promise.all([
      tool.execute(sparseCommit, context(messages)),
      tool.execute(sparseCommit, context(messages)),
    ])
    expect(results.filter((r) => r.status === "error")).toHaveLength(1)
    expect(results.filter((r) => r.status !== "error")).toHaveLength(1)
    // A new turn is reviewed again.
    expect((await tool.execute(sparseCommit, context(turn(queryPart(SPARSE_SQL, SPARSE_OUTPUT))))).status).toBe("error")
  })

  test("a history without a turn id is never reviewed", async () => {
    const tool = await initTool(AnswerCommit.AnswerCommitTool)
    const messages = [
      { info: { role: "user" }, parts: [] },
      { info: { role: "assistant" }, parts: [queryPart(SPARSE_SQL, SPARSE_OUTPUT)] },
    ]
    expect((await tool.execute(sparseCommit, context(messages))).status).not.toBe("error")
  })
})
// altimate_change end
