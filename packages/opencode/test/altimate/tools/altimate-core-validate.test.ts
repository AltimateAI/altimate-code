/**
 * Tests for AltimateCoreValidateTool — schema handling and error classification.
 *
 * The hardening here is about removing a contract mismatch: the parameter
 * schema declares `schema_path` and `schema_context` as optional, but the
 * previous implementation hard-gated on their absence and returned a terse
 * error. The fix lets the tool run with an empty schema, surfaces a clear
 * warning in the output, and still returns engine findings from the Rust
 * core (syntax/dialect checks that do not need a schema).
 */
import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import {
  AltimateCoreValidateTool,
  _altimateCoreValidateInternal as toolInternals,
} from "../../../src/altimate/tools/altimate-core-validate"
import { SessionID, MessageID } from "../../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

afterEach(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("classifyValidationError", () => {
  const { classifyValidationError } = toolInternals

  test("classifies missing column", () => {
    expect(classifyValidationError("column 'foo' not found in users")).toBe("missing_column")
    expect(classifyValidationError("Column bar not found")).toBe("missing_column")
  })

  test("classifies missing table", () => {
    expect(classifyValidationError("table 'orders' not found")).toBe("missing_table")
  })

  test("column check takes precedence over table check", () => {
    // "column X not found in table Y" should classify as missing_column,
    // not missing_table, because the column is what is actually absent.
    expect(classifyValidationError("column id not found in table users")).toBe("missing_column")
  })

  test("classifies syntax errors", () => {
    expect(classifyValidationError("syntax error near SELECT")).toBe("syntax_error")
  })

  test("classifies type mismatches", () => {
    expect(classifyValidationError("type mismatch: expected INTEGER got VARCHAR")).toBe("type_mismatch")
  })

  test("falls back to generic validation_error", () => {
    expect(classifyValidationError("some unusual semantic issue")).toBe("validation_error")
  })
})

describe("extractValidationErrors", () => {
  const { extractValidationErrors } = toolInternals

  test("joins multiple error messages with semicolons", () => {
    expect(
      extractValidationErrors({
        errors: [{ message: "missing column foo" }, { message: "missing column bar" }],
      }),
    ).toBe("missing column foo; missing column bar")
  })

  test("returns undefined when errors array is empty", () => {
    expect(extractValidationErrors({ errors: [] })).toBeUndefined()
  })

  test("returns undefined when errors field is missing", () => {
    expect(extractValidationErrors({})).toBeUndefined()
  })

  test("handles non-object error entries", () => {
    expect(extractValidationErrors({ errors: ["raw string error"] })).toBe("raw string error")
  })
})

describe("formatValidate", () => {
  const { formatValidate } = toolInternals

  test("returns 'SQL is valid.' for successful validation with schema", () => {
    expect(formatValidate({ valid: true }, true)).toBe("SQL is valid.")
  })

  test("includes schema warning for successful validation without schema", () => {
    const result = formatValidate({ valid: true }, false)
    expect(result).toContain("SQL is valid.")
    expect(result).toContain("No schema was provided")
    expect(result).toContain("schema_inspect")
  })

  test("formats validation failures with bullet list", () => {
    const result = formatValidate(
      {
        valid: false,
        errors: [
          { message: "missing column foo" },
          { message: "type mismatch in bar", location: { line: 5 } },
        ],
      },
      true,
    )
    expect(result).toContain("Validation failed")
    expect(result).toContain("missing column foo")
    expect(result).toContain("type mismatch in bar")
    expect(result).toContain("at line 5")
  })

  test("appends schema note to failures when schema is missing", () => {
    const result = formatValidate(
      { valid: false, errors: [{ message: "syntax error" }] },
      false,
    )
    expect(result).toContain("syntax error")
    expect(result).toContain("No schema was provided")
  })

  test("no double blank line between valid SQL and the schema note", () => {
    // Regression: previously the note started with `\n\n` which produced
    // `SQL is valid.\n\n\n\nNote:` when concatenated. One blank separator is
    // enough.
    const result = formatValidate({ valid: true }, false)
    expect(result).not.toContain("\n\n\n")
  })

  test("no extra blank line between failure list and the schema note", () => {
    // Regression: pushing a note that starts with `\n\n` into the `lines`
    // array and joining on `\n` produced three consecutive newlines.
    const result = formatValidate(
      { valid: false, errors: [{ message: "missing column foo" }] },
      false,
    )
    expect(result).toContain("missing column foo")
    expect(result).toContain("No schema was provided")
    expect(result).not.toContain("\n\n\n")
  })

  test("no-schema note recommends the flat table-map shape, not {tables: {...}}", () => {
    // Regression: an earlier draft of the note documented the verbose
    // SchemaDefinition shape `{tables: {...}}`, but the tool's examples and
    // tests use the flat `{users: {...}}` shape. Using the wrong shape in
    // the hint would send callers down a rabbit hole.
    const result = formatValidate({ valid: true }, false)
    expect(result).not.toContain("{tables:")
    expect(result).toMatch(/users.*INTEGER/)
  })
})

// ---------------------------------------------------------------------------
// Integration: Tool.execute with mocked Dispatcher
// ---------------------------------------------------------------------------

describe("AltimateCoreValidateTool.execute", () => {
  let dispatcherSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = undefined
  })

  function mockDispatcher(response: unknown) {
    dispatcherSpy?.mockRestore()
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => response as never)
  }

  test("runs validation even when no schema is provided", async () => {
    mockDispatcher({
      success: true,
      data: { valid: true, errors: [] },
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute({ sql: "SELECT 1" }, ctx as any)

    // The engine ran, so success should be true.
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.has_schema).toBe(false)
    expect(result.metadata.valid).toBe(true)
    // Title should indicate schema-less mode.
    expect(result.title).toContain("no schema")
    // Output should warn about the schema gap.
    expect(String(result.output)).toContain("No schema was provided")
  })

  test("runs full validation with inline schema_context", async () => {
    mockDispatcher({
      success: true,
      data: { valid: true, errors: [] },
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute(
      {
        sql: "SELECT id FROM users",
        schema_context: {
          users: { id: "INTEGER", name: "VARCHAR" },
        },
      },
      ctx as any,
    )

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.has_schema).toBe(true)
    expect(result.metadata.valid).toBe(true)
    expect(result.title).not.toContain("no schema")
    expect(String(result.output)).not.toContain("No schema was provided")
  })

  test("recognizes schema_path as schema source", async () => {
    mockDispatcher({
      success: true,
      data: { valid: true, errors: [] },
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute(
      { sql: "SELECT 1", schema_path: "/tmp/schema.yaml" },
      ctx as any,
    )

    expect(result.metadata.has_schema).toBe(true)
  })

  test("treats empty schema_context object as no schema", async () => {
    mockDispatcher({
      success: true,
      data: { valid: true, errors: [] },
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute({ sql: "SELECT 1", schema_context: {} }, ctx as any)

    expect(result.metadata.has_schema).toBe(false)
  })

  test("returns invalid result with findings when engine finds errors", async () => {
    mockDispatcher({
      success: true,
      data: {
        valid: false,
        errors: [
          { message: "column xyz not found in users" },
          { message: "syntax error near FROOM" },
        ],
      },
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute(
      {
        sql: "SELECT xyz FROOM users",
        schema_context: { users: { id: "INTEGER" } },
      },
      ctx as any,
    )

    // Engine ran successfully, so success remains true even though SQL is invalid.
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.valid).toBe(false)
    expect(result.title).toContain("INVALID")
    expect(result.metadata.findings).toBeDefined()
    expect(Array.isArray(result.metadata.findings)).toBe(true)
    // Two errors → two findings
    const findings = result.metadata.findings as Array<{ category: string }>
    expect(findings).toHaveLength(2)
    expect(findings[0].category).toBe("missing_column")
    expect(findings[1].category).toBe("syntax_error")
  })

  test("returns ERROR envelope when dispatcher throws", async () => {
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async () => {
      throw new Error("core engine crashed")
    })

    const tool = await AltimateCoreValidateTool.init()
    const result = await tool.execute({ sql: "SELECT 1" }, ctx as any)

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error_class).toBe("engine_failure")
    expect(result.title).toContain("ERROR")
    expect(String(result.output)).toContain("core engine crashed")
  })

  test("does not early-return when schema is absent (regression)", async () => {
    // Regression guard: the old implementation hard-gated on schema absence
    // and never called the dispatcher, causing 266+ identical failures.
    const spy = spyOn(Dispatcher, "call").mockImplementation(
      async () => ({ success: true, data: { valid: true, errors: [] } }) as never,
    )

    const tool = await AltimateCoreValidateTool.init()
    await tool.execute({ sql: "SELECT 1" }, ctx as any)

    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
