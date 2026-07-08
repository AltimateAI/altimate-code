import { describe, expect, test } from "bun:test"
import { sanitizeAssertionSql } from "../../src/altimate/review"

describe("sanitizeAssertionSql", () => {
  test("rejects side-effecting statements", () => {
    expect(sanitizeAssertionSql("drop table x", ["x"])).toEqual({ ok: false, reason: "side_effect" })
  })

  test("rejects semicolon-separated multi-statements", () => {
    expect(sanitizeAssertionSql("select 1; delete from y", ["y"])).toEqual({
      ok: false,
      reason: "multi_statement",
    })
  })

  test("rejects selects referencing non-allowlisted relations", () => {
    expect(sanitizeAssertionSql("select * from secret_orders", ["fct_orders"])).toEqual({
      ok: false,
      reason: "unknown_relation",
    })
  })

  test("accepts and bounds a select on allowlisted relations", () => {
    const sanitized = sanitizeAssertionSql("select order_id from fct_orders where order_id is null;", ["fct_orders"])
    expect(sanitized.ok).toBe(true)
    if (sanitized.ok) {
      expect(sanitized.sql).toBe(
        "select count(*) as n from ( select order_id from fct_orders where order_id is null ) _s",
      )
    }
  })
})
