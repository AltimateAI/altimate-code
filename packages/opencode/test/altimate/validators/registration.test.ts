// altimate_change start — registration contract for the altimate validator lane
import { describe, expect, test, afterAll } from "bun:test"
import { ValidatorRegistry } from "../../../src/session/validators/registry"
import { registerAltimateValidators } from "../../../src/altimate/validators"

/**
 * A validator that is written but never registered is invisible, and nothing
 * else in the test suite would notice. This file pins the registration list.
 */

const EXPECTED = [
  "dbt-nothing-built",
  "dbt-build-green",
  "dbt-deliverable-names",
  "dbt-incremental-config",
  "dbt-dialect-guard",
  "dbt-schema-verify",
  "dbt-tests-pass",
]

const snapshot = ValidatorRegistry.list().slice()

afterAll(() => {
  ValidatorRegistry.clear()
  for (const v of snapshot) ValidatorRegistry.register(v)
})

describe("registerAltimateValidators", () => {
  test("registers every validator in the lane, in dependency order", () => {
    ValidatorRegistry.clear()
    registerAltimateValidators()
    expect(ValidatorRegistry.list().map((v) => v.name)).toEqual(EXPECTED)
  })

  test("is idempotent", () => {
    ValidatorRegistry.clear()
    registerAltimateValidators()
    registerAltimateValidators()
    expect(ValidatorRegistry.list().length).toBe(EXPECTED.length)
  })

  test("every validator satisfies the framework contract", () => {
    ValidatorRegistry.clear()
    registerAltimateValidators()
    for (const v of ValidatorRegistry.list()) {
      expect(typeof v.appliesTo).toBe("function")
      expect(typeof v.check).toBe("function")
      expect(v.description.length).toBeGreaterThan(20)
    }
  })

  test("no validator applies to a directory that is not a dbt project", async () => {
    ValidatorRegistry.clear()
    registerAltimateValidators()
    const results = await ValidatorRegistry.runAll({
      sessionID: "s",
      workingDirectory: "/nonexistent-path-for-validator-contract-test",
      sessionStartMs: 0,
      step: 1,
      retryCount: 0,
    })
    // `runAll` records an entry only for validators whose `appliesTo` returned
    // true, and it converts a thrown check into a soft pass. Asserting "no
    // failures" would therefore also hold for a validator that wrongly ran and
    // happened to pass — which is the regression this test exists to catch.
    // The contract is that nothing runs at all outside a dbt project.
    expect(results).toEqual([])
  })
})
// altimate_change end
