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
})
