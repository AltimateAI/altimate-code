import { describe, test, expect } from "bun:test"
import YAML from "yaml"
import { detectTestAdequacy, detectThresholdLoosening, inheritedThresholds } from "../../src/altimate/review/test-adequacy"

/** Data tests that can't do their job, from yml alone (any adapter). */

const file = { path: "models/marts/_fct.yml", status: "modified" as const }
const rule = (fs: { evidence?: { result?: unknown } }[]) => fs.map((f) => (f.evidence?.result as { rule: string }).rule)

describe("tests that compare a model with itself", () => {
  const yml = (compare: string) => `models:
  - name: fct_orders
    data_tests:
      - dbt_utils.equal_rowcount:
          compare_model: ${compare}
    columns:
      - name: customer_id
        data_tests:
          - relationships:
              to: ref('fct_orders')
              field: customer_id
`
  test("own-ref comparisons and self relationships pass by construction", () => {
    const out = detectTestAdequacy({ file, newContent: yml("ref('fct_orders')") })
    expect(rule(out)).toEqual(["test-compares-model-with-itself", "test-compares-model-with-itself"])
  })

  test("a comparison with another model is fine; unchanged tests are skipped", () => {
    const other = yml("ref('stg_orders')").replace("to: ref('fct_orders')", "to: ref('dim_customers')")
    expect(detectTestAdequacy({ file, newContent: other })).toEqual([])
    expect(detectTestAdequacy({ file, oldContent: yml("ref('fct_orders')"), newContent: yml("ref('fct_orders')") })).toEqual([])
  })

  test("fewer_rows_than against itself, or an aggregation with a different expression, is not flagged", () => {
    const y = `models:
  - name: fct_orders
    data_tests:
      - dbt_utils.fewer_rows_than:
          compare_model: ref('fct_orders')
      - dbt_expectations.expect_table_aggregation_to_equal_other_table:
          expression: sum(line_total)
          compare_model: ref('fct_orders')
          compare_expression: sum(order_total)
`
    expect(detectTestAdequacy({ file, newContent: y })).toEqual([])
    const same = y.replace("sum(order_total)", "sum( line_total )")
    expect(rule(detectTestAdequacy({ file, newContent: same }))).toEqual(["test-compares-model-with-itself"])
  })

  test("dbt 1.8+ `arguments:` form is read too", () => {
    const y = `models:\n  - name: m\n    data_tests:\n      - dbt_utils.equality:\n          arguments:\n            compare_model: ref("m")\n`
    expect(rule(detectTestAdequacy({ file: { path: "models/_m.yml", status: "added" }, newContent: y }))).toEqual(["test-compares-model-with-itself"])
  })
})

describe("thresholds inherited from dbt_project.yml", () => {
  const project = `name: shop
data_tests:
  shop:
    marts:
      +severity: warn
    staging:
      +error_if: ">100"
`
  const newTests = (own = "") => `models:
  - name: fct_orders
    columns:
      - name: id
        data_tests:
          - not_null${own}
`
  test("the effective value walks project → folders, deeper wins", () => {
    const doc = YAML.parse(project)
    expect(inheritedThresholds(doc, ["marts"])).toEqual({ severity: "warn", path: ["shop", "marts"] })
    expect(inheritedThresholds(doc, ["staging", "x"])).toEqual({ error_if: ">100", path: ["shop", "staging"] })
    expect(inheritedThresholds(doc, ["core"])).toEqual({ path: [] })
  })

  test("new tests under a warn folder are reported; a test with its own severity is not", () => {
    const out = detectTestAdequacy({ file, newContent: newTests(), projectYml: project })
    expect(rule(out)).toEqual(["test-inherits-warn"])
    expect(out[0].body).toContain("`shop` → `marts`")
    const own = newTests(":\n              config:\n                severity: error").replace("- not_null:", "- not_null:")
    expect(detectTestAdequacy({ file, newContent: own, projectYml: project })).toEqual([])
  })

  test("an inherited error_if threshold is reported", () => {
    const out = detectTestAdequacy({ file: { path: "models/staging/_stg.yml", status: "modified" }, newContent: newTests(), projectYml: project })
    expect(rule(out)).toEqual(["test-inherits-threshold"])
  })

  test("a dbt_project.yml change that loosens thresholds is reported", () => {
    const before = "name: shop\ndata_tests:\n  shop:\n    marts:\n      +severity: error\n"
    const after = "name: shop\ndata_tests:\n  shop:\n    marts:\n      +severity: warn\n"
    const out = detectThresholdLoosening({ path: "dbt_project.yml", status: "modified" }, before, after)
    expect(out.map((f) => f.title)).toEqual(["test thresholds loosened for `shop → marts`"])
    expect(detectThresholdLoosening({ path: "dbt_project.yml", status: "modified" }, after, after)).toEqual([])
  })

  test("error_if: only a bound that tolerates more failures loosens; strict forms are the default", () => {
    const at = (cond: string) => `name: shop\ndata_tests:\n  shop:\n    marts:\n      +error_if: "${cond}"\n`
    const loosened = (from: string, to: string) =>
      detectThresholdLoosening({ path: "dbt_project.yml", status: "modified" }, at(from), at(to)).length > 0
    expect(loosened(">100", ">10")).toBe(false)
    expect(loosened(">10", ">100")).toBe(true)
    expect(loosened("!= 0", "> 0")).toBe(false)
    expect(loosened("!= 0", ">=1")).toBe(false)
    expect(loosened("!= 0", ">5")).toBe(true)
  })

  test("loosening is judged on effective values: a deleted stricter override is reported, a redundant warn is not", () => {
    const yml = (body: string) => `name: shop\ndata_tests:\n  +severity: warn\n  shop:\n${body}`
    const ch = (a: string, b: string) => detectThresholdLoosening({ path: "dbt_project.yml", status: "modified" }, a, b)
    // Root warn, marts override to error deleted: every marts test now warns.
    const deleted = ch(yml("    marts:\n      +severity: error\n"), yml("    marts:\n      +materialized: view\n"))
    expect(deleted.map((f) => f.title)).toEqual(["test thresholds loosened for `shop → marts`"])
    // A redundant warn under an already-warn root changes nothing.
    expect(ch(yml("    marts:\n      +enabled: true\n"), yml("    marts:\n      +severity: warn\n"))).toEqual([])
    // Loosening at the root is reported once, not again for each folder below it.
    const root = ch("data_tests:\n  shop:\n    marts:\n      x:\n        +enabled: true\n", "data_tests:\n  +severity: warn\n  shop:\n    marts:\n      x:\n        +enabled: true\n")
    expect(root.map((f) => f.title)).toEqual(["test thresholds loosened for `(all tests)`"])
  })

  test("a local warn_if or error_if leaves severity inherited", () => {
    const withCfg = (cfg: string) => newTests(`:\n              config:\n                ${cfg}`)
    expect(rule(detectTestAdequacy({ file, newContent: withCfg("warn_if: '>10'"), projectYml: project }))).toEqual(["test-inherits-warn"])
    expect(rule(detectTestAdequacy({ file, newContent: withCfg("error_if: '!= 0'"), projectYml: project }))).toEqual(["test-inherits-warn"])
    // Under an inherited threshold, a local severity: error still inherits error_if.
    const stg = { path: "models/staging/_stg.yml", status: "modified" as const }
    expect(rule(detectTestAdequacy({ file: stg, newContent: withCfg("severity: error"), projectYml: project }))).toEqual(["test-inherits-threshold"])
    expect(detectTestAdequacy({ file: stg, newContent: withCfg("error_if: '!= 0'"), projectYml: project })).toEqual([])
  })

  test("a seed yml is resolved below the seed path, not as a `seeds` folder", () => {
    const proj = "name: shop\ndata_tests:\n  shop:\n    +severity: warn\n    seeds:\n      +severity: error\n"
    const seedYml = "seeds:\n  - name: countries\n    columns:\n      - name: code\n        data_tests:\n          - not_null\n"
    const out = detectTestAdequacy({ file: { path: "seeds/_seeds.yml", status: "added" }, newContent: seedYml, projectYml: proj })
    expect(rule(out)).toEqual(["test-inherits-warn"])
  })
})

describe("cardinality_equality against the same model", () => {
  const y = (field: string) => `models:
  - name: m
    columns:
      - name: a
        data_tests:
          - dbt_utils.cardinality_equality:
              to: ref('m')
              field: ${field}
`
  test("a different field is a real check; the same field is circular", () => {
    expect(detectTestAdequacy({ file, newContent: y("b") })).toEqual([])
    expect(rule(detectTestAdequacy({ file, newContent: y("a") }))).toEqual(["test-compares-model-with-itself"])
  })
})
