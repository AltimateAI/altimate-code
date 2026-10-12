import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as core from "@altimateai/altimate-core"
import * as Registry from "../../../src/altimate/native/connections/registry"
import { checkSql, readSql } from "../../../src/altimate/tools/sql-check"
import { materialize } from "../../../src/altimate/tools/sql-materialize"
import { classifyAndCheck, isScratchSafeWrite } from "../../../src/altimate/tools/sql-classify"
import { maskSql, tokenizeSql } from "../../../src/altimate/tools/sql-tokenize"
import { lintSqlResult } from "../../../src/altimate/tools/sql-result-lint"

afterEach(() => Registry.reset())

const metadataReads = ["SHOW TABLES", "DESCRIBE orders", "EXPLAIN SELECT 1", "PRAGMA table_info(orders)"]

const attacks = [
  String.raw`SELECT E'\'--' AS a; DELETE FROM victim`,
  String.raw`SELECT E'\'--' AS a) x) y; DELETE FROM victim; SELECT * FROM (SELECT * FROM (SELECT ''`,
  "SELECT $tag$'--$tag$ AS a; DELETE FROM victim",
  "SELECT $$--$$ AS a; DELETE FROM victim",
  "SELECT 1) escaped",
  "SELECT (1",
  "SELECT 1; SELECT 2",
]

describe("read-only SQL parser boundary", () => {
  for (const sql of [...attacks, ...metadataReads]) {
    test(`refuses before check/materialize can obtain a connector: ${JSON.stringify(sql)}`, async () => {
      Registry.setConfigs({ source: { type: "postgres" } })
      const get = spyOn(Registry, "get").mockRejectedValue(new Error("connector must not be reached"))
      try {
        expect(() => readSql(sql)).toThrow(/single read-only SELECT/)
        await expect(checkSql({ warehouse: "source", check: "grain", sql, columns: ["a"] })).rejects.toThrow(
          /single read-only SELECT/,
        )
        await expect(materialize({ source_warehouse: "source", sql, target_table: "refused" })).rejects.toThrow(
          /only reads/,
        )
        expect(get).not.toHaveBeenCalled()
      } finally {
        get.mockRestore()
      }
    })
  }

  test("result lint skips metadata and multiple reads before reaching core", async () => {
    const previousLint = process.env.ALTIMATE_SQL_EXECUTE_LINT
    delete process.env.ALTIMATE_SQL_EXECUTE_LINT
    const lint = spyOn(core, "lint").mockImplementation(() => {
      throw new Error("lint must not be reached")
    })
    try {
      for (const [index, sql] of [...metadataReads, "SELECT 1; SELECT 2"].entries()) {
        expect(await lintSqlResult(sql, "source", `read-safety-lint-${index}`)).toBeUndefined()
      }
      expect(lint).not.toHaveBeenCalled()
    } finally {
      lint.mockRestore()
      if (previousLint === undefined) delete process.env.ALTIMATE_SQL_EXECUTE_LINT
      else process.env.ALTIMATE_SQL_EXECUTE_LINT = previousLint
    }
  })

  for (const sql of [
    String.raw`SELECT E'\'--' AS a`,
    String.raw`SELECT E'\\' AS a`,
    // Two actual backslashes escape each other: the following -- really is a
    // comment. The one-backslash attack above instead escapes the closing quote.
    String.raw`SELECT E'\\'--' AS a) x) y; DELETE FROM victim; SELECT * FROM (SELECT * FROM (SELECT ''`,
    "SELECT 'it''s -- not a comment; DELETE' AS a",
    "SELECT $tag$'-- ; DELETE /*$tag$ AS a",
    "SELECT $$--$$ AS a",
    'SELECT "--" AS "/*", "semi;colon" FROM "order"',
  ]) {
    test(`preserves a quoted read: ${JSON.stringify(sql)}`, () => {
      expect(readSql(sql)).toBe(sql)
    })
  }

  test("parser failure never falls back to a read-shaped prefix", () => {
    expect(classifyAndCheck("SELECT (1").queryType).toBe("write")
    expect(classifyAndCheck("WITH invalid syntax").queryType).toBe("write")
  })

  test("the scratch write exemption does not admit statements the parser skipped", () => {
    expect(isScratchSafeWrite("DELETE FROM t; CHECKPOINT")).toBe(false)
    expect(isScratchSafeWrite("DELETE FROM t; INSERT INTO t VALUES (1)")).toBe(true)
  })

  test("unterminated quoted content is not an empty read", () => {
    expect(classifyAndCheck("/* unclosed comment").queryType).toBe("write")
    expect(classifyAndCheck("SELECT 'unclosed").queryType).toBe("write")
  })

  test("masking independently retains statements after escape and dollar literals", () => {
    for (const sql of [attacks[0], attacks[2], attacks[3]]) {
      const { tokens, complete } = tokenizeSql(sql)
      expect(complete).toBe(true)
      expect(maskSql(tokens)).toMatch(/; DELETE FROM victim$/)
    }
    expect(maskSql(tokenizeSql("SELECT $$-- ; DELETE$$ AS a -- actual comment").tokens)).toMatch(/^SELECT\s+AS a\s+$/)
  })

  test("hard denies survive a parser failure after a completed statement", () => {
    expect(classifyAndCheck("DROP DATABASE prod; SELECT 'unclosed").blocked).toBe(true)
  })
})
