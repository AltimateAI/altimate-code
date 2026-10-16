import { afterAll, expect, mock, test } from "bun:test"
import { restoreModuleMocksAfterTests } from "./module-mock"

const original = { ...await import("node:querystring") }

await restoreModuleMocksAfterTests("@altimateai/missing-optional-test-dependency", "node:querystring")

mock.module("node:querystring", () => ({
  ...original,
  stringify: () => "mocked",
}))

test("unavailable optional modules do not prevent installed modules from being mocked", async () => {
  const querystring = await import("node:querystring")
  expect(querystring.stringify({ key: "value" })).toBe("mocked")
})

afterAll(async () => {
  const querystring = await import("node:querystring")
  expect(querystring.stringify).toBe(original.stringify)
  expect(querystring.stringify({ key: "value" })).toBe("key=value")
})
