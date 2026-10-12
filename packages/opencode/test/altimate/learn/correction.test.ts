// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { correctionReason } from "../../../src/altimate/learn/correction"

const POSITIVE: string[] = [
  // Verbatim reviews from the corrections-only run; the first-pass classifier missed both.
  "The model has three issues: `discount_cents` and `min_order_cents` aren't converted to dollars with `cents_to_dollars()` and renamed (they can't remain as `*_cents` columns in staging output), and the source has `_is_deleted` so those rows must be filtered.",
  "Two issues in `stg_shop__refunds.sql`: the `refunded_ts` timestamp isn't wrapped in `{{ to_utc('refunded_ts') }}` before being renamed to `refunded_at`, and `_is_deleted` is being passed through as `is_deleted` instead of being used as a filter.",
  "The schema YAML is missing the unique test on the primary key.",
  "amount_cents needs to be converted before it reaches staging.",
  "Timestamps aren't normalized to UTC here.",
  "I see a couple of problems with the staging model.",
  "that's wrong",
  "That is incorrect, the model should be incremental.",
  "this is not right",
  "Incorrect.",
  "no, we never use select *; always list columns explicitly",
  "No - use ref() here",
  "nope, put it in the staging folder",
  "you forgot the schema test",
  "You missed the unique test on the primary key.",
  "you didn't add a description to the model",
  "also you haven't updated the yml",
  "we always prefix staging models with stg_",
  "we never hardcode schema names",
  "our convention is snake_case column names",
  "That's against the team rule: marts are materialized as tables.",
  "the model should be materialized as incremental",
  "That should have been a view.",
  "Use ref() instead of the raw table name",
  "please use the surrogate key macro instead",
  "don't use select * in models",
  "Do not hardcode the database name.",
  "please don't add comments to the sql",
  "actually, this belongs in the intermediate layer",
  "Why did you hardcode the schema?",
  "why didn't you run the tests first",
  "rename the model to stg_orders",
  "use the generate_surrogate_key macro for the hash",
  "I said use ref, not source",
  "again you forgot the not_null test",
  "that's not what I asked for",
  "Nice start. But you missed the incremental filter.",
  "Thanks for this. We always add a unique test on the primary key, please add one.",
  [
    "A couple of review comments on this PR.",
    "The CTE names should be descriptive, not cte1 and cte2.",
    "Also we never use `select *` in marts, please list the columns.",
  ].join("\n"),
  [
    "Looks mostly good!",
    "One thing: you didn't add the `unique` and `not_null` tests for `order_id` in schema.yml.",
    "Our convention is to document every column.",
  ].join(" "),
  "dbt review: the join should be a left join, orders without customers must stay.",
  "Never use the table alias `t`; always name aliases after the model.",
]

const NEGATIVE: string[] = [
  "No issues, LGTM.",
  "Now add a staging model for raw_disputes; it must be ready by Friday.",
  "Are there any issues with the current pipeline?",
  "thanks!",
  "Thank you, that works.",
  "LGTM",
  "lgtm, ship it",
  "looks good to me",
  "great, thanks. That's exactly what I wanted.",
  "perfect",
  "now add a model for customers",
  "next, create a staging model for payments",
  "Create a file notes.sql with select 1",
  "can you also add a dimension table for products?",
  "what does this do?",
  "how does the incremental strategy work here?",
  "Which materialization is used for the orders model?",
  "explain the join logic",
  "run the tests",
  "no problem, thanks",
  "no worries",
  "ok",
  "yes please go ahead",
  "show me the compiled sql",
  "That should be fine.",
  "it should be able to run now I think",
  "Don't worry about it, thanks.",
  "actually that works great, thanks",
  "",
  "   ",
  "```sql\nselect * from orders -- should be a ref\n```",
  "Why is the build slow?",
  "Can you explain why you used a CTE?",
  "Looks great overall. Nice work on the tests.",
  "I noticed the model is incremental. How is the unique key chosen?",
]

describe("correctionReason: positive", () => {
  for (const text of POSITIVE) {
    test(JSON.stringify(text.slice(0, 70)), () => {
      expect(correctionReason(text)).toBeString()
    })
  }
})

describe("correctionReason: negative", () => {
  for (const text of NEGATIVE) {
    test(JSON.stringify(text.slice(0, 70)), () => {
      expect(correctionReason(text)).toBeUndefined()
    })
  }
})

describe("correctionReason: edge cases", () => {
  test("more than 30 of each", () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(30)
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(30)
  })

  test("a plain question is not a correction but a why-did-you challenge is", () => {
    expect(correctionReason("what should be the name of this model?")).toBeUndefined()
    expect(correctionReason("why did you use select *?")).toBeString()
  })

  test("a correction in a later sentence is found", () => {
    expect(correctionReason("Thanks. Good job. But you forgot the tests.")).toBeString()
  })

  test("fenced code and pasted logs do not count", () => {
    expect(correctionReason("run this:\n```\nwe never do this and you forgot\n```")).toBeUndefined()
  })

  test("negative assessments and reassurance do not count as corrections", () => {
    for (const text of ["It shouldn't be a problem.", "That should not be an issue.", "This shouldn't be a concern."])
      expect(correctionReason(text)).toBeUndefined()
    expect(correctionReason("The model shouldn't be a table; use a view.")).toBeString()
    expect(correctionReason("This shouldn't be a problem. But you forgot the tests.")).toBeString()
  })

  test("reassurance about any or plural problems does not count as a correction", () => {
    for (const text of ["It shouldn't have any problems.", "There should not be any issues.", "That shouldn't have problems.", "This shouldn't be any concern."])
      expect(correctionReason(text)).toBeUndefined()
    expect(correctionReason("The model shouldn't have any unconverted amount_cents.")).toBeString()
  })

  test("plain pasted diagnostics do not count but adjacent user corrections do", () => {
    for (const text of [
      "ERROR: amount_cents needs to be converted before staging",
      "[ERROR] amount_cents needs to be converted before staging",
      "2026-10-03 12:34:56 ERROR: amount_cents needs to be converted before staging",
      "12:34:56 [WARNING] amount_cents should be converted before staging",
    ]) {
      expect(correctionReason(text)).toBeUndefined()
      expect(correctionReason(`${text}\nYou forgot the not_null test.`)).toBeString()
    }
  })

  test("ordinary questions stay questions before closing quotes or brackets", () => {
    for (const text of [
      '"What should be the name of this model?"',
      "'What should be the name of this model?'",
      "“What should be the name of this model?”",
      "(What should be the name of this model?)",
      "[What should be the name of this model?]",
      '("What should be the name of this model?")',
    ]) expect(correctionReason(text)).toBeUndefined()
    expect(correctionReason('"Why did you hardcode the schema?"')).toBeString()
    expect(correctionReason('"What should be the model name?" Thanks.')).toBeUndefined()
    expect(correctionReason('"What should be the model name?" You forgot the tests.')).toBeString()
  })

  test("is bounded for huge input", () => {
    expect(correctionReason("x ".repeat(500_000))).toBeUndefined()
  })

  test("non-string input is ignored", () => {
    expect(correctionReason(undefined as unknown as string)).toBeUndefined()
  })
})
