// dbt-tests-pass: "nothing to check" must not be reported as "check failed".
// Runs the real check() against a stand-in altimate-dbt. The dbt output strings are
// verbatim captures (dbt 1.12.5 / dbt-duckdb 1.11.0, ANSI codes included) from a real
// project; the "Nothing to do" shape is what the benchmark sessions received as
// "could not run tests: no PASS/ERROR summary in dbt output".
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DbtTestsPassValidator, isNothingToTest } from "../../../src/altimate/validators/dbt-tests-pass"
import { retryErroredSerially } from "../../../src/altimate/validators/validator-utils"
import { ctxFor, installFakeAltimateDbt, type FakeAltimateDbt } from "./fake-altimate-dbt.helper"

let fake: FakeAltimateDbt

beforeEach(async () => {
  fake = await installFakeAltimateDbt()
})
afterEach(async () => {
  await fake.restore()
})

const envelope = (stdout: string) => JSON.stringify({ stdout }, null, 2)

// `altimate-dbt test --model <model with no tests>`
const NO_TESTS =
  "\u001b[0m21:00:21  Running with dbt=1.12.5\n\u001b[0m21:00:21  Registered adapter: duckdb=1.11.0\n\u001b[0m21:00:22  Found 7 models, 1 seed, 7 data tests, 616 macros\n\u001b[0m21:00:22  [\u001b[33mWARNING\u001b[0m]: Nothing to do. Try checking your model configs and model specification args\n"

// Same, when the selector matches no enabled node (disabled model, name that is not in the graph).
const UNMATCHED =
  "\u001b[0m21:00:21  Running with dbt=1.12.5\n\u001b[0m21:00:22  Found 7 models, 1 seed, 7 data tests, 616 macros\n\u001b[0m21:00:22  [\u001b[33mWARNING\u001b[0m]: The selection criterion 'ghost' does not match any enabled nodes\n\u001b[0m21:00:22  [\u001b[33mWARNING\u001b[0m]: Nothing to do. Try checking your model configs and model specification args\n"

const PASSING =
  "\u001b[0m21:00:26  Found 7 models, 1 seed, 7 data tests, 616 macros\n\u001b[0m21:00:27  1 of 2 PASS not_null_tested_id ........................................... [\u001b[32mPASS\u001b[0m in 0.13s]\n\u001b[0m21:00:27  2 of 2 PASS unique_tested_id ............................................. [\u001b[32mPASS\u001b[0m in 0.12s]\n\u001b[0m21:00:28  \u001b[32mCompleted successfully\u001b[0m\n\u001b[0m21:00:28  Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 REUSED=0 TOTAL=2\n"

const FAILING =
  "\u001b[0m21:00:46  Found 7 models, 1 seed, 7 data tests, 616 macros\n\u001b[0m21:00:47  1 of 1 FAIL 3 accepted_values_failing_id__99 ................................... [\u001b[31mFAIL 3\u001b[0m in 0.09s]\n\u001b[0m21:00:47  \u001b[31mCompleted with 1 error, 0 partial successes, and 0 warnings:\u001b[0m\n\u001b[0m21:00:47  Done. PASS=0 WARN=0 ERROR=1 SKIP=0 NO-OP=0 REUSED=0 TOTAL=1\n"

// A real error while running the tests (what GPT airbnb001 got when processes contended for DuckDB).
const LOCK_ERROR =
  "\u001b[0m20:41:14  Found 12 models, 15 data tests\n\u001b[0m20:41:14  Encountered an error:\nRuntime Error\n  IO Error: Could not set lock on file \"/app/./airbnb.duckdb\": Conflicting lock is held\n"

const FIX_THE_SQL = /Fix the model SQL/

async function run(models: Record<string, { stdout?: string; error?: string; code?: number }>) {
  for (const [model, r] of Object.entries(models)) {
    await fake.touchModel(model)
    const body = r.error !== undefined ? JSON.stringify({ error: r.error, stdout: r.stdout ?? "" }) : envelope(r.stdout ?? "")
    await fake.respond("test", model, body, r.code ?? 0)
  }
  return DbtTestsPassValidator.check(ctxFor(fake.project))
}

describe("dbt-tests-pass: a model with no tests is not an error", () => {
  test("dbt says 'Nothing to do': passes, sends nothing, records it for telemetry", async () => {
    const r = await run({ untested: { stdout: NO_TESTS } })
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.fixHint).toBeUndefined()
    expect(r.details).toMatchObject({ no_tests: 1, no_tests_models: ["untested"], passed: 0 })
  })

  test("a model with no YAML entry at all behaves the same", async () => {
    const r = await run({ no_yaml: { stdout: NO_TESTS } })
    expect(r.ok).toBe(true)
  })

  test("selector matching no enabled node is nothing to check, and is recorded as such", async () => {
    const r = await run({ ghost: { stdout: UNMATCHED } })
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ no_tests: 1, unmatched_selector_models: ["ghost"] })
  })

  test("dbt's stderr noise next to 'Nothing to do' does not turn it into an error", async () => {
    const r = await run({ untested: { stdout: NO_TESTS, error: "[WARNING]: Deprecated functionality" } })
    expect(r.ok).toBe(true)
  })

  test("a model without tests next to a model with passing tests: both pass", async () => {
    const r = await run({ untested: { stdout: NO_TESTS }, tested: { stdout: PASSING } })
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ no_tests: 1, passed: 1 })
  })

  test("the message never says 'could not be tested' for a model without tests", async () => {
    const r = await run({ untested: { stdout: NO_TESTS }, failing: { stdout: FAILING } })
    expect(r.ok).toBe(false)
    const message = `${r.reason}\n${r.fixHint}`
    expect(message).toContain("failing")
    expect(message).not.toContain("untested")
    expect(message).not.toContain("could not be tested")
  })
})

describe("dbt-tests-pass still fails when tests exist and fail, or cannot run", () => {
  test("tests exist and fail: names the failing tests and keeps the model-SQL advice", async () => {
    const r = await run({ failing: { stdout: FAILING } })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("failing dbt tests: failing")
    expect(r.fixHint).toContain("accepted_values_failing_id__99")
    expect(r.fixHint).toMatch(FIX_THE_SQL)
  })

  test("tests exist and the run hits a real error: fails, says the run failed, and does not blame the SQL", async () => {
    const r = await run({ orders: { stdout: LOCK_ERROR } })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("could not be tested because the dbt test run itself failed: orders")
    expect(r.fixHint).toContain("Could not set lock")
    expect(r.fixHint).not.toMatch(FIX_THE_SQL)
  })

  test("'Nothing to do' next to an abort marker is not trusted as 'no tests'", async () => {
    const r = await run({ orders: { stdout: `${LOCK_ERROR}\n[WARNING]: Nothing to do. Try checking your model configs and model specification args\n` } })
    expect(r.ok).toBe(false)
  })

  test("'Nothing to do' in stdout does not hide an error that only reached stderr", async () => {
    const r = await run({ orders: { stdout: NO_TESTS, error: "Runtime Error\n  IO Error: Could not set lock on file" } })
    expect(r.ok).toBe(false)
    expect(r.details).toMatchObject({ errored: 1 })
  })

  test("a failing test is still reported when dbt also wrote to stderr (envelope carries an error and the full log)", async () => {
    const r = await run({ failing: { stdout: FAILING, error: "[WARNING]: Deprecated functionality" } })
    expect(r.ok).toBe(false)
    expect(r.fixHint).toContain("accepted_values_failing_id__99")
  })

  test("passing tests plus stderr noise pass", async () => {
    const r = await run({ tested: { stdout: PASSING, error: "[WARNING]: Deprecated functionality" } })
    expect(r.ok).toBe(true)
  })

  test("a passing summary next to dbt's own abort text is an error, not a pass", async () => {
    const r = await run({ tested: { stdout: PASSING, error: "Encountered an error:\nRuntime Error\n  IO Error: Could not set lock" } })
    expect(r.ok).toBe(false)
    expect(r.details).toMatchObject({ errored: 1 })
  })

  test("no summary and no 'Nothing to do' (truncated or unrecognised output) stays an error", async () => {
    const r = await run({ orders: { stdout: "\u001b[0m21:00:22  Found 7 models\n" } })
    expect(r.ok).toBe(false)
    expect(r.details).toMatchObject({ errored: 1 })
  })
})

describe("dbt-tests-pass: errors from a parallel run are retried one at a time", () => {
  test("contention error that disappears serially does not fail the validator", async () => {
    await fake.touchModel("orders")
    await fake.respondInSequence("test", "orders", [{ stdout: envelope(LOCK_ERROR) }, { stdout: envelope(PASSING) }])
    const r = await DbtTestsPassValidator.check(ctxFor(fake.project))
    expect(r.ok).toBe(true)
    expect(r.details).toMatchObject({ retried_serially: 1, passed: 1 })
  })

  test("an error that survives the retry is reported", async () => {
    const r = await run({ orders: { stdout: LOCK_ERROR } })
    expect(r.ok).toBe(false)
    expect(r.details).toMatchObject({ retried_serially: 1, errored: 1 })
  })

  test("genuinely failing tests are not retried", async () => {
    await run({ failing: { stdout: FAILING } })
    expect((await fake.calls()).filter((c) => c === "test failing").length).toBe(1)
  })
})

describe("isNothingToTest", () => {
  test("recognises dbt's notice through ANSI colour codes", () => {
    expect(isNothingToTest(NO_TESTS)).toEqual({ noTests: true, unmatchedSelector: false })
    expect(isNothingToTest(UNMATCHED)).toEqual({ noTests: true, unmatchedSelector: true })
  })

  test("older wording 'No nodes selected' counts too", () => {
    expect(isNothingToTest("12:00:00  [WARNING]: No nodes selected!").noTests).toBe(true)
  })

  test("a run summary wins over any notice", () => {
    expect(isNothingToTest(`${NO_TESTS}\n${PASSING}`).noTests).toBe(false)
  })

  test("empty and unrelated output are not 'no tests'", () => {
    expect(isNothingToTest("").noTests).toBe(false)
    expect(isNothingToTest(undefined as unknown as string).noTests).toBe(false)
    expect(isNothingToTest("Compilation Error in model x").noTests).toBe(false)
  })
})

describe("retryErroredSerially", () => {
  test("a retry that cannot start keeps the original error instead of erasing it", async () => {
    const first = { model: "orders", error: "Could not set lock" }
    const { outputs, retried } = await retryErroredSerially(["orders"], [first], async () => null, (o) => o.error)
    expect(retried).toBe(1)
    expect(outputs[0]).toBe(first)
  })
})
