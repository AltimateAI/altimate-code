import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import z from "zod"
import { legacyToInit, zodToJsonSchema } from "../../../src/altimate/tool-zod-compat"
import { Agent } from "../../../src/agent/agent"
import { Tool } from "../../../src/tool/tool"
import { Truncate } from "../../../src/tool/truncate"

function fakeToolServices(options?: { truncateResult?: Truncate.Result }) {
  const truncateCalls: string[] = []
  const truncate = Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.succeed("/tmp/upi-tool-output"),
    limits: () => Effect.succeed({ maxLines: 1, maxBytes: 8 }),
    output: (text: string) => {
      truncateCalls.push(text)
      return Effect.succeed(options?.truncateResult ?? { content: text, truncated: false as const })
    },
  })
  const agent = Agent.Service.of({
    get: (name: string) =>
      Effect.succeed({
        name,
        mode: "primary",
        permission: [],
        options: {},
      } as any),
    list: () => Effect.succeed([]),
    defaultInfo: () => Effect.die("not needed"),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("not needed"),
  })
  return { truncate, agent, truncateCalls }
}

function provideToolServices<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  services = fakeToolServices(),
): Effect.Effect<A, E, Exclude<R, Truncate.Service | Agent.Service>> {
  return effect.pipe(
    Effect.provideService(Truncate.Service, services.truncate),
    Effect.provideService(Agent.Service, services.agent),
  ) as any
}

function toolContext(overrides: Partial<Tool.Context> = {}): Tool.Context {
  return {
    sessionID: "ses_upi" as any,
    messageID: "msg_upi" as any,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    ...overrides,
  }
}

describe("UPI-11 legacy zod schemas through Effect declarations", () => {
  test("zodToJsonSchema preserves descriptions, required fields, enums, and nested optional fields", () => {
    const schema = z
      .object({
        mode: z.enum(["safe", "fast"]).describe("execution mode"),
        count: z.coerce.number().int().default(3).describe("retry count"),
        nested: z.object({ flag: z.boolean().optional().describe("nested flag") }).optional(),
      })
      .describe("legacy params")

    const json = zodToJsonSchema(schema) as any
    expect(json.description).toBe("legacy params")
    expect(json.required).toEqual(["mode"])
    expect(json.properties.mode.enum).toEqual(["safe", "fast"])
    expect(json.properties.mode.description).toBe("execution mode")
    expect(json.properties.count.default).toBe(3)
    expect(json.properties.nested.properties.flag.description).toBe("nested flag")
  })

  test("legacy declarations decode through zod parse, so defaults, coercions, and transforms survive", async () => {
    const def = await Effect.runPromise(
      legacyToInit({
        description: "legacy",
        parameters: z.object({
          count: z.coerce.number().int().default(7),
          label: z.string().trim().transform((value) => value.toUpperCase()),
        }),
        async execute(args) {
          return { title: "ok", metadata: { args }, output: "" }
        },
      }),
    )

    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(def.parameters)({ label: "  alpha " }))
    expect(decoded).toEqual({ count: 7, label: "ALPHA" })
  })

  test("legacy declarations reject missing required fields and wrong enum values before execution", async () => {
    const def = await Effect.runPromise(
      legacyToInit({
        description: "legacy",
        parameters: z.object({ mode: z.enum(["safe", "fast"]) }),
        async execute() {
          return { title: "should not run", metadata: {}, output: "" }
        },
      }),
    )

    const decode = Schema.decodeUnknownEffect(def.parameters)
    expect(Exit.isFailure(await Effect.runPromiseExit(decode({})))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(decode({ mode: "root" })))).toBe(true)
  })

  test("zod JSON Schema normalization drops boolean exclusive bounds that downstream schemas reject", () => {
    const json = zodToJsonSchema(z.object({ n: z.number().gt(0).lt(10) }))
    const serialized = JSON.stringify(json)
    expect(serialized).not.toContain('"exclusiveMinimum":true')
    expect(serialized).not.toContain('"exclusiveMaximum":true')
  })

  // BUG: legacy formatter recovery reads error.actual, but Effect SchemaError nests
  // the original input under error.issue.actual. The wrapper dies with TypeError
  // when a legacy formatter expects a z.ZodError.
  test.todo("legacy zod formatValidationError receives recovered ZodError paths", async () => {
    let executed = false
    const info = await Effect.runPromise(
      provideToolServices(
        Tool.define("legacy_format", {
          description: "legacy",
          parameters: z.object({ mode: z.enum(["safe"]) }),
          async execute() {
            executed = true
            return { title: "bad", metadata: {}, output: "" }
          },
          formatValidationError(error) {
            return error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join("|")
          },
        }),
      ),
    )
    const def = await Effect.runPromise(info.init())
    const exit = await Effect.runPromiseExit(def.execute({ mode: "bad" } as any, toolContext()))
    expect(executed).toBe(false)
    expect(String(exit)).toContain("mode")
  })
})

describe("UPI-12 and UPI-13 tool context, decode, and central truncation", () => {
  test("legacy execute receives bridged metadata and ask callbacks after async work", async () => {
    const events: string[] = []
    const def = await Effect.runPromise(
      legacyToInit({
        description: "legacy",
        parameters: z.object({ name: z.string() }),
        async execute(args: { name: string }, ctx) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          ctx.metadata({ title: args.name, metadata: { stage: "metadata" } })
          await ctx.ask({ permission: "bash", patterns: ["echo *"], always: ["echo *"], metadata: {} })
          return { title: "done", metadata: { ok: true }, output: "ok" }
        },
      }),
    )

    const result = await Effect.runPromise(
      def.execute(
        { name: "alpha" },
        toolContext({
          metadata: (input) =>
            Effect.sync(() => {
              events.push(`metadata:${input.title}:${input.metadata?.stage}`)
            }),
          ask: (input) =>
            Effect.sync(() => {
              events.push(`ask:${input.permission}:${input.patterns.join(",")}:${input.always}`)
            }),
        }),
      ),
    )

    expect(result.output).toBe("ok")
    expect(events).toEqual(["metadata:alpha:metadata", "ask:bash:echo *:echo *"])
  })

  test("Tool.define decodes zod defaults before execute and truncates unmarked large output once", async () => {
    const services = fakeToolServices({
      truncateResult: { content: "PREVIEW", truncated: true, outputPath: "/tmp/upi-tool-output" },
    })
    const seenArgs: unknown[] = []
    const info = await Effect.runPromise(
      provideToolServices(
        Tool.define("legacy_truncate", {
          description: "legacy",
          parameters: z.object({ value: z.string().default("decoded") }),
          async execute(args) {
            seenArgs.push(args)
            return { title: "ok", metadata: {}, output: "very long output" }
          },
        }),
        services,
      ),
    )
    const def = await Effect.runPromise(info.init())
    const result = await Effect.runPromise(def.execute({} as any, toolContext()))

    expect(seenArgs).toEqual([{ value: "decoded" }])
    expect(services.truncateCalls).toEqual(["very long output"])
    expect(result.output).toBe("PREVIEW")
    expect(result.metadata).toEqual({ truncated: true, outputPath: "/tmp/upi-tool-output" })
  })

  test("Tool.define does not double-truncate results that already carry truncation metadata", async () => {
    const services = fakeToolServices({
      truncateResult: { content: "SHOULD_NOT_APPEAR", truncated: true, outputPath: "/tmp/wrong" },
    })
    const info = await Effect.runPromise(
      provideToolServices(
        Tool.define("legacy_already_truncated", {
          description: "legacy",
          parameters: z.object({}),
          async execute() {
            return {
              title: "ok",
              metadata: { truncated: true, outputPath: "/tmp/already" },
              output: "existing preview",
            }
          },
        }),
        services,
      ),
    )
    const def = await Effect.runPromise(info.init())
    const result = await Effect.runPromise(def.execute({}, toolContext()))

    expect(services.truncateCalls).toEqual([])
    expect(result.output).toBe("existing preview")
    expect(result.metadata.outputPath).toBe("/tmp/already")
  })

  test("Tool.define rejects invalid arguments before the legacy execute function runs", async () => {
    let executed = false
    const info = await Effect.runPromise(
      provideToolServices(
        Tool.define("legacy_invalid", {
          description: "legacy",
          parameters: z.object({ allowed: z.literal("yes") }),
          async execute() {
            executed = true
            return { title: "bad", metadata: {}, output: "" }
          },
        }),
      ),
    )
    const def = await Effect.runPromise(info.init())
    const exit = await Effect.runPromiseExit(def.execute({ allowed: "no" } as any, toolContext()))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(executed).toBe(false)
  })
})
