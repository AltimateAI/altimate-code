import { describe, expect, test } from "bun:test"
import { hasSideEffectFunction, isReadOnlyNestedFunction } from "../../../src/altimate/tools/sql-function-policy"
import { sqlFunctionCalls } from "../../../src/altimate/tools/sql-functions"

describe("hasSideEffectFunction", () => {
  test.each([
    "nextval",
    "setval",
    "set_config",
    "load_extension",
    "writefile",
    "dblink",
    "dblink_exec",
    "lo_import",
    "lo_unlink",
    "checkpoint",
    "get_lock",
    "release_all_locks",
    "sleep",
    "benchmark",
    "postgres_execute",
    "mysql_execute",
    "sqlite_execute",
    "SYSTEM$CANCEL_QUERY",
  ])("flags generic side-effect function %s", (name) => {
    expect(hasSideEffectFunction(name)).toBe(true)
  })

  test.each([
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_advisory_lock",
    "pg_try_advisory_lock",
    "pg_advisory_xact_lock_shared",
    "pg_notify",
    "pg_switch_wal",
    "pg_create_logical_replication_slot",
    "pg_drop_replication_slot",
    "pg_copy_logical_replication_slot",
    "pg_copy_physical_replication_slot",
    "pg_sync_replication_slots",
    "pg_promote",
    "pg_advisory_unlock_all",
    "pg_stat_reset",
    "pg_stat_reset_single_table_counters",
    "pg_stat_statements_reset",
    "pg_stat_clear_snapshot",
    "pg_write_file",
    "pg_backup_start",
  ])("flags PostgreSQL side-effect function %s even when unknown pg_* is allowed", (name) => {
    expect(hasSideEffectFunction(name)).toBe(true)
    expect(hasSideEffectFunction(name, false)).toBe(true)
  })

  test.each([
    "pg_relation_size",
    "pg_total_relation_size",
    "pg_size_pretty",
    "pg_get_viewdef",
    "pg_backend_pid",
    "pg_is_in_recovery",
    "pg_table_is_visible",
    "pg_has_role",
    "pg_stat_get_live_tuples",
    "pg_current_wal_lsn",
    "pg_typeof",
  ])("allows read-only PostgreSQL inspection function %s", (name) => {
    expect(hasSideEffectFunction(name)).toBe(false)
  })

  test.each(["count", "coalesce", "lower", "json_extract", "my_udf"])(
    "does not flag non-pg function %s",
    (name) => {
      expect(hasSideEffectFunction(name)).toBe(false)
    },
  )

  test("unknown pg_* functions are denied by default and allowed when not strict", () => {
    expect(hasSideEffectFunction("pg_sleep")).toBe(true)
    expect(hasSideEffectFunction("pg_some_future_function")).toBe(true)
    expect(hasSideEffectFunction("pg_sleep", false)).toBe(false)
    expect(hasSideEffectFunction("pg_some_future_function", false)).toBe(false)
  })

  test("matches function names case-insensitively", () => {
    expect(hasSideEffectFunction("NEXTVAL")).toBe(true)
    expect(hasSideEffectFunction("NextVal")).toBe(true)
    expect(hasSideEffectFunction("PG_TERMINATE_BACKEND")).toBe(true)
    expect(hasSideEffectFunction("system$cancel_query")).toBe(true)
    expect(hasSideEffectFunction("PG_RELATION_SIZE")).toBe(false)
    expect(hasSideEffectFunction("PG_SLEEP")).toBe(true)
  })

  test("takes one bare identifier: schema-qualified or quoted text is not decoded", () => {
    // Callers pass the decoded name from sqlFunctionCalls; raw SQL text never matches.
    expect(hasSideEffectFunction("public.nextval")).toBe(false)
    expect(hasSideEffectFunction('"nextval"')).toBe(false)
    expect(hasSideEffectFunction("nextval(")).toBe(false)
    expect(hasSideEffectFunction("nextval_safe")).toBe(false)
  })

  test("empty input is not a side-effect function", () => {
    expect(hasSideEffectFunction("")).toBe(false)
    expect(hasSideEffectFunction("", false)).toBe(false)
  })
})

describe("isReadOnlyNestedFunction", () => {
  test.each([
    "count",
    "sum",
    "coalesce",
    "lower",
    "substring",
    "date_trunc",
    "json_extract",
    "row_number",
    "generate_series",
    "current_setting",
    "cast",
    "exists",
    "to_regclass",
  ])("allows allowlisted function %s", (name) => {
    expect(isReadOnlyNestedFunction(name)).toBe(true)
  })

  test.each(["pg_relation_size", "pg_get_viewdef", "pg_table_is_visible", "has_table_privilege", "has_schema_privilege"])(
    "allows read-only catalog function %s",
    (name) => {
      expect(isReadOnlyNestedFunction(name)).toBe(true)
    },
  )

  test.each(["nextval", "set_config", "dblink", "pg_terminate_backend", "pg_stat_reset", "pg_sleep", "sleep"])(
    "rejects side-effect function %s",
    (name) => {
      expect(isReadOnlyNestedFunction(name)).toBe(false)
    },
  )

  test.each(["my_udf", "refresh_materialized", "query", "postgres_query", "eval", "pg_some_future_function"])(
    "fails closed for unknown function %s",
    (name) => {
      expect(isReadOnlyNestedFunction(name)).toBe(false)
    },
  )

  test("allows pg_catalog and information_schema qualifiers only", () => {
    expect(isReadOnlyNestedFunction("count", "pg_catalog")).toBe(true)
    expect(isReadOnlyNestedFunction("pg_get_viewdef", "pg_catalog")).toBe(true)
    expect(isReadOnlyNestedFunction("count", "information_schema")).toBe(true)
    expect(isReadOnlyNestedFunction("count", "public")).toBe(false)
    expect(isReadOnlyNestedFunction("lower", "analytics")).toBe(false)
    expect(isReadOnlyNestedFunction("count", "")).toBe(false)
  })

  test("a catalog qualifier does not make a side-effect function safe", () => {
    expect(isReadOnlyNestedFunction("nextval", "pg_catalog")).toBe(false)
    expect(isReadOnlyNestedFunction("set_config", "pg_catalog")).toBe(false)
    expect(isReadOnlyNestedFunction("my_udf", "pg_catalog")).toBe(false)
  })

  test("expects lowercased names and qualifiers, failing closed otherwise", () => {
    // sqlFunctionCalls lowercases both; anything else is treated as unknown.
    expect(isReadOnlyNestedFunction("COUNT")).toBe(false)
    expect(isReadOnlyNestedFunction("count", "PG_CATALOG")).toBe(false)
    expect(isReadOnlyNestedFunction("NEXTVAL")).toBe(false)
  })

  test("empty input is not read-only", () => {
    expect(isReadOnlyNestedFunction("")).toBe(false)
    expect(isReadOnlyNestedFunction("", "pg_catalog")).toBe(false)
  })
})

describe("policy applied to names decoded by sqlFunctionCalls", () => {
  const decoded = (sql: string) => sqlFunctionCalls(sql, "postgres")[0]

  test.each([
    ["SELECT nextval('s')", "nextval"],
    ["SELECT NEXTVAL('s')", "nextval"],
    ['SELECT "nextval"(\'s\')', "nextval"],
    ['SELECT "NextVal"(\'s\')', "nextval"],
    ["SELECT public.nextval('s')", "nextval"],
  ])("%s is a side-effect call", (sql, name) => {
    const call = decoded(sql)
    expect(call.name).toBe(name)
    expect(hasSideEffectFunction(call.name)).toBe(true)
    expect(isReadOnlyNestedFunction(call.name, call.qualifier)).toBe(false)
  })

  test("quoted and uppercase allowlisted calls stay read-only", () => {
    for (const sql of ['SELECT "COUNT"(*) FROM t', "SELECT COUNT(*) FROM t", 'SELECT "pg_catalog"."count"(*) FROM t']) {
      const call = decoded(sql)
      expect(isReadOnlyNestedFunction(call.name, call.qualifier)).toBe(true)
    }
  })

  test("schema-qualified user functions require write permission", () => {
    const call = decoded("SELECT analytics.count(*) FROM t")
    expect(call.qualifier).toBe("analytics")
    expect(isReadOnlyNestedFunction(call.name, call.qualifier)).toBe(false)
  })
})
