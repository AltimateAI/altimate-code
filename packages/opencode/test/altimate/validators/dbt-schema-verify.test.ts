// dbt-schema-verify: what the validator may tell the agent. Runs the real check()
// (spawn, parse, decide) against a stand-in altimate-dbt whose output has the shapes
// seen in recorded ADE-Bench sessions (GPT airbnb001/airbnb002, Sonnet asana001).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DbtSchemaVerifyValidator } from "../../../src/altimate/validators/dbt-schema-verify"
import { ctxFor, installFakeAltimateDbt, type FakeAltimateDbt } from "./fake-altimate-dbt.helper"

let fake: FakeAltimateDbt

beforeEach(async () => {
  fake = await installFakeAltimateDbt()
})
afterEach(async () => {
  await fake.restore()
})

const DESTRUCTIVE = /\b(REMOVE|ADD|REORDER|CAST)\b|do not edit the spec|equality tests will fail/

/** New altimate-dbt output: only established problems are in `findings`. */
const verdict = (model: string, o: Record<string, unknown>) => JSON.stringify({ model, ...o }, null, 2)

// airbnb001: YAML lists the two tested columns; the model returns six.
const monthlyYamlListsSome = verdict("monthly_agg_reviews", {
  verdict: "match",
  spec: { declared_in: "models/agg/schema.yml", package: "airbnb", contract_enforced: false },
  expected_columns: ["DATE_SENTIMENT_ID", "REVIEW_SENTIMENT"],
  actual_columns: ["REVIEW_TOTALS", "REVIEW_SENTIMENT", "MONTH_YEAR", "MONTH", "YEAR", "DATE_SENTIMENT_ID"],
  columns_extra: ["REVIEW_TOTALS", "MONTH_YEAR", "MONTH", "YEAR"],
  columns_missing: [],
  columns_reordered: [{ column: "DATE_SENTIMENT_ID", actual_position: 5, expected_position: 0 }],
  type_mismatches: [],
  findings: [],
  notes: ["The built table has `REVIEW_TOTALS`, not listed in `models/agg/schema.yml`. dbt does not require YAML to list every column, so this is not an error."],
})

// The same model as an older altimate-dbt reported it (no `findings`): what the benchmark agents received.
const monthlyLegacy = verdict("monthly_agg_reviews", {
  verdict: "mismatch",
  expected_columns: ["DATE_SENTIMENT_ID", "REVIEW_SENTIMENT"],
  actual_columns: ["REVIEW_TOTALS", "REVIEW_SENTIMENT", "MONTH_YEAR", "MONTH", "YEAR", "DATE_SENTIMENT_ID"],
  columns_extra: ["REVIEW_TOTALS", "MONTH_YEAR", "MONTH", "YEAR"],
  columns_missing: [],
  columns_reordered: [{ column: "DATE_SENTIMENT_ID", actual_position: 5, expected_position: 0 }],
  type_mismatches: [],
})

// asana001: package YAML declares assignee_status (no test), the model never produced it.
const asanaDeclaredButAbsent = verdict("stg_asana__task", {
  verdict: "match",
  spec: { declared_in: "models/stg_asana.yml", package: "asana_source", contract_enforced: false },
  expected_columns: ["task_id", "assignee_status"],
  actual_columns: ["task_id", "name"],
  columns_extra: ["name"],
  columns_missing: ["assignee_status"],
  columns_reordered: [],
  type_mismatches: [],
  findings: [],
  notes: ["`models/stg_asana.yml` in package `asana_source` (not this project) declares `assignee_status`, which the built table does not have. No test or contract depends on it, so this may be a stale or aspirational YAML entry rather than a defect in the model."],
})

const testedColumnMissing = verdict("orders", {
  verdict: "mismatch",
  spec: { declared_in: "models/schema.yml", package: "shop", contract_enforced: false },
  expected_columns: ["id", "customer_email"],
  actual_columns: ["id", "email"],
  columns_extra: ["email"],
  columns_missing: ["customer_email"],
  columns_reordered: [],
  type_mismatches: [],
  findings: [
    {
      kind: "tested-column-missing",
      columns: ["customer_email"],
      evidence:
        "`models/schema.yml` declares column(s) with tests attached that the built table does not have: `customer_email` (tests: not_null_orders_customer_email). Those tests read a column that does not exist.",
    },
  ],
  notes: [],
})

const contractMismatch = verdict("payments", {
  verdict: "mismatch",
  spec: { declared_in: "models/payments.yml", package: "shop", contract_enforced: true },
  expected_columns: ["id", "amount"],
  actual_columns: ["id", "amount", "currency"],
  columns_extra: ["currency"],
  columns_missing: [],
  columns_reordered: [],
  type_mismatches: [],
  findings: [
    {
      kind: "contract-extra-columns",
      columns: ["currency"],
      evidence:
        "`models/payments.yml` declares an enforced contract that does not list `currency`, but the built table has it. dbt rejects a contract-enforced model whose columns differ from the contract.",
    },
  ],
  notes: [],
})

const noSpec = verdict("scratch", {
  verdict: "no-spec",
  message: "Model 'scratch' has no columns declared in YAML. There is no declaration to compare against.",
  actual_columns: ["a", "b"],
})

async function run(models: Record<string, string>) {
  for (const [model, out] of Object.entries(models)) {
    await fake.touchModel(model)
    await fake.respond("schema-verify", model, out)
  }
  return DbtSchemaVerifyValidator.check(ctxFor(fake.project))
}

describe("dbt-schema-verify stays silent when nothing is established", () => {
  test("YAML lists only some columns: the extra columns are not reported (airbnb001/airbnb002 shape)", async () => {
    const r = await run({ monthly_agg_reviews: monthlyYamlListsSome })
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.fixHint).toBeUndefined()
    expect(r.details).toMatchObject({ models_touched: 1, match: 1, errored: 0 })
  })

  test("older altimate-dbt output (verdict mismatch, no findings) is not treated as established", async () => {
    const r = await run({ monthly_agg_reviews: monthlyLegacy })
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ diff_not_established: 1 })
  })

  test("declared column that nothing depends on and the model lacks (asana001 shape): silent", async () => {
    const r = await run({ stg_asana__task: asanaDeclaredButAbsent })
    expect(r.ok).toBe(true)
    expect(r.fixHint).toBeUndefined()
  })

  test("model with no YAML entry at all: nothing to compare, silent", async () => {
    const r = await run({ scratch: noSpec })
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ no_spec: 1 })
  })
})

describe("dbt-schema-verify still fails when dbt's own semantics establish a problem", () => {
  test("declared column with tests attached that the model does not produce", async () => {
    const r = await run({ orders: testedColumnMissing })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("orders")
    // Evidence: which file declares what, and which tests depend on it.
    expect(r.fixHint).toContain("models/schema.yml")
    expect(r.fixHint).toContain("customer_email")
    expect(r.fixHint).toContain("not_null_orders_customer_email")
  })

  test("enforced contract that the built table does not match", async () => {
    const r = await run({ payments: contractMismatch })
    expect(r.ok).toBe(false)
    expect(r.fixHint).toContain("models/payments.yml")
    expect(r.fixHint).toContain("enforced contract")
    expect(r.fixHint).toContain("currency")
  })

  test("only the model with an established problem is named; a sibling with unlisted columns is not", async () => {
    const r = await run({ monthly_agg_reviews: monthlyYamlListsSome, orders: testedColumnMissing })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("1 of 2")
    expect(r.reason).toContain("orders")
    expect(r.reason).not.toContain("monthly_agg_reviews")
    expect(r.fixHint).not.toContain("REVIEW_TOTALS")
  })

  test("a tool error is still a failure (cannot rule drift out) and now carries its cause", async () => {
    await fake.touchModel("orders")
    await fake.respond(
      "schema-verify",
      "orders",
      JSON.stringify({ error: "Model 'orders' is in the manifest but has no warehouse table. Build it first: altimate-dbt build --model orders" }),
      1,
    )
    const r = await DbtSchemaVerifyValidator.check(ctxFor(fake.project))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("could not be schema-verified")
    expect(r.reason).toContain("has no warehouse table")
  })
})

describe("what the agent is told never instructs a destructive change", () => {
  const cases: Array<[string, string]> = [
    ["tested column missing", testedColumnMissing],
    ["contract mismatch", contractMismatch],
  ]
  for (const [name, out] of cases) {
    test(`${name}: no remove/add/reorder command and no 'do not edit the spec'`, async () => {
      const model = JSON.parse(out).model as string
      const r = await run({ [model]: out })
      expect(r.ok).toBe(false)
      const message = `${r.reason}\n${r.fixHint}`
      expect(message).not.toMatch(DESTRUCTIVE)
      // It presents both sides as possibly wrong.
      expect(message).toContain("change the model if the YAML is right, or the YAML if its entry is stale")
    })
  }
})

describe("parallel-run errors are retried one at a time", () => {
  test("an error that does not repeat serially (warehouse contention) does not fail the validator", async () => {
    await fake.touchModel("orders")
    await fake.respondInSequence("schema-verify", "orders", [
      {
        stdout: JSON.stringify({ error: "Failed to read actual columns for 'orders': Cannot read properties of undefined (reading 'data')" }),
        exitCode: 1,
      },
      { stdout: verdict("orders", { verdict: "match", findings: [], notes: [] }) },
    ])
    const r = await DbtSchemaVerifyValidator.check(ctxFor(fake.project))
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ retried_serially: 1, errored: 0 })
    expect((await fake.calls()).filter((c) => c === "schema-verify orders").length).toBe(2)
  })

  test("an error that repeats serially is reported", async () => {
    await fake.touchModel("orders")
    await fake.respond("schema-verify", "orders", JSON.stringify({ error: "boom" }), 1)
    const r = await DbtSchemaVerifyValidator.check(ctxFor(fake.project))
    expect(r.ok).toBe(false)
    expect(r.details).toMatchObject({ retried_serially: 1, errored: 1 })
  })
})
