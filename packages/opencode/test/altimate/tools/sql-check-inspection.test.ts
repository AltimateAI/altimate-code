import { describe, expect, test } from "bun:test"
import { readSql } from "../../../src/altimate/tools/sql-check"
import { classifyAndCheck } from "../../../src/altimate/tools/sql-classify"

describe("sql_check PostgreSQL inspection functions", () => {
  test("sql_check's conservative allowlist does not restrict ordinary classifier inspection reads", () => {
    for (const sql of ["SELECT pg_current_logfile()", "SELECT pg_xact_status(1)", "SELECT pg_last_committed_xact()"]) {
      expect(classifyAndCheck(sql, "postgres")).toEqual({ queryType: "read", blocked: false })
      expect(() => readSql(sql, "postgres")).toThrow("read-only SELECT")
    }
  })

  for (const [name, args] of [
    ["pg_input_error_info", "'not-an-integer', 'integer'"],
    ["pg_last_xact_replay_timestamp", ""],
    ["pg_is_wal_replay_paused", ""],
  ]) {
    for (const identifier of [name, `pg_catalog.${name}`, `"pg_catalog"."${name}"`]) {
      test(`accepts the read-only inspection call ${identifier}`, () => {
        const sql = `SELECT ${identifier}(${args})`
        expect(readSql(sql, "postgres")).toBe(sql)
      })
    }

    test(`does not extend the allowlist to ${name}_unsafe`, () => {
      expect(() => readSql(`SELECT ${name}_unsafe(${args})`, "postgres")).toThrow("read-only SELECT")
    })
  }

  for (const sql of [
    "SELECT pg_wal_replay_pause()",
    'SELECT "pg_catalog"."pg_wal_replay_resume"()',
    "SELECT pg_cancel_backend(123)",
    "SELECT pg_stat_reset_example_size()",
    "SELECT pg_input_error_info('bad', 'integer'), pg_cancel_backend(123)",
    "SELECT pg_last_xact_replay_timestamp(), pg_wal_replay_pause()",
    "SELECT pg_is_wal_replay_paused(), pg_wal_replay_resume()",
  ]) {
    test(`continues to reject state-changing sibling calls: ${sql}`, () => {
      expect(() => readSql(sql, "postgres")).toThrow("read-only SELECT")
    })
  }
})
