// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { anchors, sharedAnchors } from "../../../src/altimate/learn/anchors"

const cents = "In staging models, integer columns ending in `_cents` must be converted using the `{{ cents_to_dollars(...) }}` macro."
const inline = "Convert integer `*_cents` columns by dividing inline (`amount_cents / 100.0 as amount`)."
const timestamp = "Every timestamp column must be wrapped with the `{{ to_utc('col') }}` macro and aliased with the `_at` suffix."
const timezone = "Normalize timestamp columns with `convert_timezone('UTC', col)` and keep the original column name; do not rename them with an `_at` suffix."

describe("anchors", () => {
  test("normalizes Jinja, quotes, case, and repeated identifiers", () => {
    expect(anchors('Use `{{ CENTS_TO_DOLLARS(...) }}`, `"Amount_Cents"`, and `amount_cents`.')).toEqual(
      new Set(["cents_to_dollars", "amount_cents"]),
    )
  })

  test("ignores arguments, including nested calls and quoted parentheses", () => {
    expect(anchors("Use `{{ TO_UTC(coalesce(event_at, fallback(')'))) }}` with `CAST(amount_cents as decimal)`.")).toEqual(
      new Set(["to_utc"]),
    )
  })

  test("preserves grouped expressions while skipping function-call arguments", () => {
    expect(anchors("Use `(orders.amount_cents > 0)`.")).toEqual(new Set(["orders", "amount_cents"]))
    expect(anchors("Use `where (orders.amount_cents > 0) and (net_cents > 0 or not (is_deleted))`.")).toEqual(
      new Set(["orders", "amount_cents", "net_cents", "is_deleted"]),
    )
    expect(anchors("Use `(amount_cents + cents_to_dollars (ignored_cents))`.")).toEqual(
      new Set(["amount_cents", "cents_to_dollars"]),
    )
  })

  test("preserves grouped expressions after DISTINCT and QUALIFY", () => {
    expect(anchors("Use `select distinct (orders.amount_cents > 0)`.")).toEqual(new Set(["orders", "amount_cents"]))
    expect(anchors("Use `qualify (row_number > 1)`.")).toEqual(new Set(["row_number"]))
  })

  test("EXISTS and VALUES keep grouped identifiers without becoming overlap anchors", () => {
    expect(anchors("Use `exists (select invoice_id from invoices)`.")).toEqual(new Set(["invoice_id", "invoices"]))
    expect(anchors("Use `values (net_cents, 2)`.")).toEqual(new Set(["net_cents"]))
    expect(sharedAnchors("Use `exists (select invoice_id from invoices)`.", "Use `exists (select user_id from users)`.")).toEqual([])
    expect(sharedAnchors("Use `values (1, 2)`.", "Use `values (3, 4)`.")).toEqual([])
  })

  test("ignores single-quoted SQL literals, including escaped quotes", () => {
    expect(sharedAnchors("Use `status = 'active'`.", "Use `state = 'active'`.")).toEqual([])
    expect(anchors("Use `status = 'can''t use fake_identifier'`.")).toEqual(new Set(["status"]))
    expect(anchors("Use `status = 'can\\'t use fake_identifier'`.")).toEqual(new Set(["status"]))
    expect(anchors("Use `status = 'unfinished fake_identifier`.")).toEqual(new Set(["status"]))
  })

  test("keeps identifiers between SQL comparison operators", () => {
    expect(anchors("Use `subtotal < maximum AND current_total > minimum`.")).toEqual(
      new Set(["subtotal", "maximum", "current_total", "minimum"]),
    )
    expect(anchors("Use `stg_<entity>` and `<column_name>_cents`.")).toEqual(new Set(["stg_", "_cents"]))
  })

  test("splits code into identifier tokens and drops SQL keywords and placeholders", () => {
    expect(anchors("Use `select x, col from table where not _is_deleted and sql is null or true`.")).toEqual(
      new Set(["_is_deleted"]),
    )
    expect(anchors("Use `orders.amount_cents / 100.0 as amount`.")).toEqual(new Set(["orders", "amount_cents", "amount"]))
  })

  test("ignores generic SQL and Jinja functions and words", () => {
    expect(anchors("Use `coalesce cast sum count min max avg lower upper trim round nullif date_trunc date timestamp concat ref source config var case if`.")).toEqual(new Set())
  })

  test("normalizes affix placeholders", () => {
    expect(anchors("Use `*_cents`, `_cents`, `stg_`, and `stg_<entity>`.")).toEqual(new Set(["_cents", "stg_"]))
  })

  test("ignores identifiers in prose and empty or punctuation-only code spans", () => {
    expect(anchors("amount_cents to_utc stg_ `` `...` `_` `123` ")).toEqual(new Set())
  })

  test("matches single and multiple backtick delimiters", () => {
    expect(anchors("Use `amount_cents`, or ``stg_orders``.")).toEqual(new Set(["amount_cents", "stg_orders"]))
  })
})

describe("sharedAnchors", () => {
  test("cents conventions overlap across macro and inline conversion", () => {
    expect(sharedAnchors(cents, inline)).toEqual(["_cents"])
  })

  test("timestamp conventions overlap even when the suffix is forbidden", () => {
    expect(sharedAnchors(timestamp, timezone)).toEqual(["_at"])
  })

  test("soft-delete conventions overlap across an example and a SQL expression", () => {
    const filter = "If a source table has a soft-delete flag (e.g. `_is_deleted`), filter it out with `where not _is_deleted`."
    expect(sharedAnchors(filter, "Keep `_is_deleted` in staging output.")).toEqual(["_is_deleted"])
  })

  test("distinct cents and timestamp conventions do not overlap", () => {
    expect(sharedAnchors(cents, timestamp)).toEqual([])
    expect(sharedAnchors(inline, timezone)).toEqual([])
  })

  test("generic SQL functions do not connect currency and timestamp conventions", () => {
    const currency = "Default `_cents` values with `coalesce(amount_cents, 0)` before conversion."
    const timestamp = "Fill `_at` values with `coalesce(event_at, current_timestamp)` before normalization."
    expect(sharedAnchors(currency, timestamp)).toEqual([])
  })

  test("a bullet without code spans overlaps nothing", () => {
    expect(sharedAnchors("Convert amount_cents using cents_to_dollars.", cents)).toEqual([])
    expect(sharedAnchors("Plain convention", "Plain convention")).toEqual([])
  })

  test("suffix anchors match complete identifier endings in either order", () => {
    expect(sharedAnchors("Use `_cents`.", "Keep `amount_cents`.")).toEqual(["_cents"])
    expect(sharedAnchors("Keep `amount_cents`.", "Use `*_cents`.")).toEqual(["_cents"])
    expect(sharedAnchors("Use `_cents`.", "Keep `cents_amount` and `amount_cents_extra`.")).toEqual([])
  })

  test("prefix anchors match complete identifier beginnings in either order", () => {
    expect(sharedAnchors("Use `stg_`.", "Keep `stg_orders`.")).toEqual(["stg_"])
    expect(sharedAnchors("Keep `stg_orders`.", "Use `stg_<entity>`.")).toEqual(["stg_"])
    expect(sharedAnchors("Use `stg_<entity>`.", "Keep `orders_stg` and `mystg_orders`.")).toEqual([])
  })

  test("shared anchors are unique and sorted", () => {
    expect(sharedAnchors("Use `zebra` with `_cents` and `zebra`.", "Use `zebra`, `amount_cents`, and `net_cents`.")).toEqual([
      "_cents", "zebra",
    ])
  })
})
