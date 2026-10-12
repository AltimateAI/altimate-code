import z from "zod"
import { Effect, Option, Schema, SchemaIssue } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Tool } from "../../tool/tool"

// Strict-schema callers fill unused optional properties with null, "", [] or {}.
// Only optional properties accept these fillers; required values still validate.
function optional<T extends z.ZodType>(schema: T) {
  return z
    .union([schema, z.null(), z.literal(""), z.array(z.never()).length(0), z.object({}).strict()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return undefined
      if (Array.isArray(value) && value.length === 0) return undefined
      if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return undefined
      return value as z.output<T>
    })
}

const number = z
  .number()
  .refine(
    (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
    "Numeric integers must be safe integers; supply larger values as a string",
  )

const field = z
  .object({
    name: z.string().describe("Field label; use an empty name for an unnamed value"),
    value: z
      .union([z.string(), number], { error: "Each field value must be one non-empty string or number" })
      .refine((value) => typeof value !== "string" || value.trim().length > 0, "Field value must be non-empty"),
    units: optional(z.string()),
    precision: optional(z.number().int().min(0).max(10)).describe(
      "Decimal places for numeric values; integers stay integers",
    ),
  })
  .strict()

const rows = z
  .object({
    columns: z.array(z.string()).min(1, "rows.columns requires at least one column"),
    values: z
      .array(z.array(z.union([z.string(), number, z.null()])))
      .min(1, "rows.values requires at least one row")
      .describe(
        "Concrete result rows; when the request names N, the row count must equal N, even with a tie at the top-N boundary",
      ),
    note: optional(z.string()).describe(
      "Brief result note, including any tie at the top-N boundary; omitted when answer_only is true",
    ),
  })
  .strict()
  .superRefine((rows, ctx) => {
    rows.values.forEach((row, index) => {
      if (row.length !== rows.columns.length) {
        ctx.addIssue({
          code: "custom",
          path: ["values", index],
          message: `Row ${index} must have exactly ${rows.columns.length} cells; received ${row.length}`,
        })
      }
    })
  })

const basisRequired =
  "basis is always required: supply one or two sentences naming population, grain, source object/column, and caveats"

const parameters = z
  .object({
    fields: optional(
      z.array(field).superRefine((fields, ctx) => {
        if (fields.length === 1) return
        fields.forEach((field, index) => {
          if (field.name !== "" && !field.name.trim()) {
            ctx.addIssue({
              code: "custom",
              path: [index, "name"],
              message: "Field name must be non-empty",
            })
          }
        })
      }),
    ),
    rows: optional(rows),
    unresolved: optional(
      z
        .object({
          reason: z.string().refine((value) => value.trim().length > 0, "unresolved.reason must be non-empty"),
        })
        .strict(),
    ),
    basis: z
      .string({ error: basisRequired })
      .refine((value) => value.trim().length > 0, basisRequired)
      .refine(
        (value) =>
          value
            .replace(/\b(?:e\.g|i\.e|etc|Dr|vs|approx)\./gi, (word) => word.replaceAll(".", ""))
            .split(/[.?!](?:\s+(?=\S)|$)/u)
            .filter((part) => part.trim()).length <= 2,
        "basis must contain at most 2 sentences",
      )
      .describe(
        "basis is always required: one or two sentences naming population, grain, the source object/column that supplies the requested entity or value, and caveats; never rendered with answer_only",
      ),
    answer_only: optional(z.boolean()),
    readings: optional(
      z.array(
        z
          .object({
            clause: z.string(),
            reading: z.string(),
            result_summary: z.string(),
            decided_by: z.string(),
          })
          .strict(),
      ),
    ).describe("Advisory readings recorded only in metadata, never in the answer text"),
  })
  .strict()
  .refine(
    (value) => [value.fields, value.rows, value.unresolved].filter((shape) => shape !== undefined).length === 1,
    "Exactly one of fields, rows, or unresolved is required",
  )

export type AnswerCommitInput = z.input<typeof parameters>

// Tolerate boolean aliases at runtime while advertising the canonical boolean schema.
// Only answer_only is boolean; answer values and table cells must remain untouched.
const parser = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("answer_only" in input)) return input
  const value = typeof input.answer_only === "string" ? input.answer_only.toLowerCase() : input.answer_only
  const answer_only =
    value === "true" || value === 1 ? true : value === "false" || value === 0 ? false : input.answer_only
  return { ...input, answer_only }
}, parameters)

function validationError(error: z.ZodError): string {
  const describe = (issues: z.core.$ZodIssue[], parent: PropertyKey[] = []): string[] =>
    issues.flatMap((issue) => {
      const path = [...parent, ...issue.path]
      // The first union member is the actual value schema; the others are fillers.
      if (issue.code === "invalid_union" && issue.errors[0]?.length && !issue.message.includes("Each field value"))
        return describe(issue.errors[0], path)
      return [`${path.join(".") || "answer_commit"}: ${issue.message}`]
    })
  const message = describe(error.issues).join("; ").replace(/\s+/g, " ")
  const example = {
    fields: [{ name: "", value: 2 }],
    basis: "Counted all records at record grain using records.id; no exclusions.",
  }
  return `${message}\nMinimal valid example: \`${JSON.stringify(example)}\``
}

function tableCell(value: string | number | null): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, " ")
}

/** Deterministically finalize a data-question answer without changing session state. */
export function renderAnswer(payload: unknown): string {
  const parsed = parser.safeParse(payload)
  if (!parsed.success) throw new Error(validationError(parsed.error))
  const args = parsed.data
  const basis = !args.answer_only && args.basis ? `${args.basis}\n\n` : ""
  if (args.fields) {
    const single = args.fields.length === 1
    const values = args.fields
      .map((field) => {
        const value =
          typeof field.value === "number" && field.precision !== undefined && !Number.isInteger(field.value)
            ? field.value.toFixed(field.precision)
            : String(field.value)
        const redundant = single && ["", "answer", "result", "value"].includes(field.name.trim().toLowerCase())
        const name = !args.answer_only && field.name && !redundant ? `${field.name}: ` : ""
        return `${name}${value}${field.units ? ` ${field.units}` : ""}`
      })
      .join("; ")
    return args.answer_only ? values : `${basis}**Answer:** ${values}`
  }
  if (args.rows) {
    const row = (cells: (string | number | null)[]) => `| ${cells.map(tableCell).join(" | ")} |`
    const table = [
      row(args.rows.columns),
      `|${args.rows.columns.map(() => "---").join("|")}|`,
      ...args.rows.values.map(row),
    ].join("\n")
    return args.answer_only ? table : `${basis}**Answer:**\n${table}${args.rows.note ? `\n${args.rows.note}` : ""}`
  }
  const unresolved = `unable to determine — ${args.unresolved!.reason}`
  return args.answer_only ? unresolved : `${basis}**Answer:** ${unresolved}`
}

// Keep the renderer and native Effect tool on the same parser, including filler normalization.
const Parameters = Schema.declareConstructor<z.output<typeof parameters>, AnswerCommitInput>()([], () => (input) => {
  const parsed = parser.safeParse(input)
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new SchemaIssue.InvalidValue(Option.some(input), { message: validationError(parsed.error) }))
})

export const AnswerCommitTool = Tool.define(
  "answer_commit",
  Effect.succeed({
    description:
      "Deterministically finalize a data-question answer. Call this as the LAST tool call, once the answer is decided and all queries are finished. After it returns, reply with exactly the returned text and nothing else. Supply exactly one of fields, rows, or unresolved. Always supply `basis`; it is never shown when the request asks for only the answer. Supply one or two sentences naming population, grain, the source object/column that supplies the requested entity or value, and caveats. Resolve policy eligibility separately from metric and entity attribution: a rule about a related object does not change which object supplies the requested entity. Say in `basis` which source object and column supply it. When the request names N, rows.values must contain exactly N concrete rows, even with a tie at the top-N boundary; note the tie briefly in rows.note. Use answer_only when the request asks for only the answer or a specific format: the reply is exactly the value(s) or table, with no basis, field names, note, or answer label. An unresolved answer retains its unable-to-determine status. Omit unused optional properties. In JSON-schema mode, this tool is not automatically removed when a user output schema is set; the user schema takes precedence.",
    parameters: Parameters,
    formatValidationError: (error: unknown) => (Schema.isSchemaError(error) ? error.message : String(error)),
    // Preserve the existing wire schema; Zod and the SDK use different recursive JSON Schema types.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    jsonSchema: z.toJSONSchema(parameters, { io: "input" }) as JSONSchema7,
    execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (ctx.agent !== "analyst")
          return yield* Effect.die(new Error("answer_commit is only available to the analyst agent"))
        yield* ctx.ask({ permission: "answer_commit", patterns: ["*"], always: ["*"], metadata: {} })
        return {
          title: "Answer committed",
          metadata: { readings: args.readings ?? [], truncated: false },
          output: renderAnswer(args),
        }
      }),
  }),
)

export * as AnswerCommit from "./answer-commit"
