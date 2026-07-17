import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Log } from "../../src/altimate/util/log"

// Regression guard for the TUI log-flood bug: the fork log shim must be QUIET by default and only
// write to stderr when --print-logs (OPENCODE_PRINT_LOGS=1) is set. The TUI runs the server
// in-process, so an always-on stderr writer corrupts the TUI. Past upstream merges re-flooded the
// TUI by dropping the entrypoint Log.init() calls — these tests assert the shim is self-correcting
// from the env (no init() required) so a merge can't reintroduce the flood.
describe("Log shim — stderr print gating", () => {
  let writes: string[]
  let spy: ReturnType<typeof spyOn>

  beforeEach(() => {
    writes = []
    delete process.env["OPENCODE_PRINT_LOGS"]
    delete process.env["ALTIMATE_PRINT_LOGS"]
    spy = spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    spy.mockRestore()
    delete process.env["OPENCODE_PRINT_LOGS"]
    delete process.env["ALTIMATE_PRINT_LOGS"]
  })

  test("is QUIET by default (no env, no init) — the TUI-flood regression guard", () => {
    Log.create({ service: "test" }).info("should-not-appear")
    expect(writes.join("")).toBe("")
  })

  test("time() is also quiet by default (server.ts Log.time was the flood source)", () => {
    using _ = Log.create({ service: "server" }).time("request", { path: "/api/model" })
    expect(writes.join("")).toBe("")
  })

  test("prints to stderr when OPENCODE_PRINT_LOGS=1", () => {
    process.env["OPENCODE_PRINT_LOGS"] = "1"
    Log.create({ service: "test" }).info("hello-stderr")
    expect(writes.join("")).toContain("hello-stderr")
  })

  test("accepts OPENCODE_PRINT_LOGS=true as well", () => {
    process.env["OPENCODE_PRINT_LOGS"] = "true"
    Log.create({ service: "test" }).warn("warn-line")
    expect(writes.join("")).toContain("warn-line")
  })

  test("ALTIMATE_PRINT_LOGS=1 also enables printing", () => {
    process.env["ALTIMATE_PRINT_LOGS"] = "1"
    Log.create({ service: "test" }).error("err-line")
    expect(writes.join("")).toContain("err-line")
  })

  test("env is read LAZILY (set after the logger is created still takes effect)", () => {
    const logger = Log.create({ service: "test" })
    logger.info("before-enable")
    expect(writes.join("")).toBe("")
    process.env["OPENCODE_PRINT_LOGS"] = "1"
    logger.info("after-enable")
    expect(writes.join("")).toContain("after-enable")
    expect(writes.join("")).not.toContain("before-enable")
  })

  test("init({ print: true }) forces printing", () => {
    Log.init({ print: true })
    Log.create({ service: "test" }).info("init-on")
    expect(writes.join("")).toContain("init-on")
  })

  test("init({ print: false }) silences even when env enabled it", () => {
    process.env["OPENCODE_PRINT_LOGS"] = "1"
    Log.init({ print: false })
    Log.create({ service: "test" }).info("init-off")
    expect(writes.join("")).toBe("")
  })
})
