import { expect, test } from "bun:test"
import { readOnlyCaveat } from "../../src/altimate/native/connections/read-only"

test("a malformed connection without a string type gets no caveat instead of throwing", () => {
  expect(readOnlyCaveat({ name: "broken" })).toBeUndefined()
  expect(readOnlyCaveat({ name: "broken", type: 42 })).toBeUndefined()
})

test("enforcing drivers get no caveat; others do", () => {
  expect(readOnlyCaveat({ name: "pg", type: "PostgreSQL" })).toBeUndefined()
  expect(readOnlyCaveat({ name: "wh", type: "snowflake" })).toContain("wh (snowflake): read-only is enforced by SQL classification only")
})
