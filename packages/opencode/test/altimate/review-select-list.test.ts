import { describe, test, expect } from "bun:test"
import { selectListNames } from "../../src/altimate/review/select-list"

describe("final SELECT output names", () => {
  test("aliases, bare and qualified columns, literals and functions", () => {
    expect(
      selectListNames("select o.id, lower(kind) as kind, current_date as load_date, 1 as one, count(*) cnt, case when a then 1 end flag from t o"),
    ).toEqual(["id", "kind", "load_date", "one", "cnt", "flag"])
  })
  test("the last top-level SELECT wins over CTEs and subqueries", () => {
    expect(selectListNames("with a as (select x, y from t) select a.x, (select max(z) from u) as mz from a")).toEqual(["x", "mz"])
  })
  test("ambiguous items contribute nothing; operators are not aliases", () => {
    expect(selectListNames("select a + b, c - 1 as d, case when e then 1 end from t")).toEqual(["d"])
  })
  test("a star makes the list unknown; comments and strings don't confuse it", () => {
    expect(selectListNames("select t.*, x from t")).toBeNull()
    expect(selectListNames("select 'a, b' as s, -- , trailing\n y from t")).toEqual(["s", "y"])
    expect(selectListNames("select distinct id, name from t")).toEqual(["id", "name"])
  })
})
