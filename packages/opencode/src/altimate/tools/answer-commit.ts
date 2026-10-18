import z from "zod"
import { Decimal } from "decimal.js"
import { Effect, Option, Schema, SchemaIssue } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Tool } from "../../tool/tool"
import {
  COVERAGE_REJECTION_MARKER,
  MAX_COVERAGE_REJECTIONS,
  MAX_NUMBER_REJECTIONS,
  MAX_READING_REJECTIONS,
  NUMBER_REJECTION_MARKER,
  READING_REJECTION_MARKER,
  coverageRejection,
  missingAskedItems,
  numberRejection,
  priorRejections,
  readingRejection,
  sessionNumbers,
  sizeBasedRejections,
  unsourcedNumbers,
} from "./answer-commit-checks"

/** Maximum rendered answer length, including Markdown and basis, before the model echoes it. */
export const MAX_RENDERED_ANSWER_CHARACTERS = 60_000
export const MAX_BASIS_CHARACTERS = 400

const renderedLengthGuidance = `Rendered answer text must not exceed ${MAX_RENDERED_ANSWER_CHARACTERS.toLocaleString("en-US")} characters; aggregate, narrow the result, or write the full table to a file and commit the summary.`

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
    "Numeric integers must be safe; pass the exact value as a string",
  )

const precisionRange = "precision must be an integer from 0 to 10 (inclusive)"
const precision = z.number({ error: precisionRange }).int(precisionRange).min(0, precisionRange).max(10, precisionRange)

const field = z
  .object({
    name: z.string().describe("Field label; use an empty name for an unnamed value"),
    value: z
      .union([z.string(), number], { error: "Each field value must be one non-empty string or number" })
      .refine((value) => typeof value !== "string" || value.trim().length > 0, "Field value must be non-empty"),
    units: optional(z.string()),
    precision: optional(precision).describe(
      "Decimal places for numeric values: integer from 0 to 10 (inclusive); integers stay integers",
    ),
  })
  .strict()

const rows = z
  .object({
    columns: z.array(z.string()).min(1, "rows.columns requires at least one column"),
    // altimate_change start - preserve the tabular format requested in text mode
    format: optional(z.enum(["markdown", "csv", "tsv", "lines"])).describe(
      "Tabular output format: markdown (default), csv, tsv, or lines. CSV/TSV include headers and quote delimiters, quotes, and newlines; null cells are empty. Lines omits headers and separates cells with one space for single-column or two-column plain lists.",
    ),
    // altimate_change end
    values: z
      .array(z.array(z.union([z.string(), number, z.null()])))
      .min(1, "rows.values requires at least one row")
      .describe(
        "Concrete result rows; when the request names N, the row count must equal N, even with a tie at the top-N boundary",
      ),
    precision: optional(z.record(z.string(), precision)).describe(
      "Display decimal places by column name: integer from 0 to 10 (inclusive). Numeric cells use fixed decimals, including integers; strings and nulls are unchanged. Omitted columns use the maximum decimal scale of their numeric cells.",
    ),
    note: optional(z.string()).describe(
      "Brief result note, including any tie at the top-N boundary; omitted when answer_only is true",
    ),
  })
  .strict()
  .superRefine((rows, ctx) => {
    if (rows.precision !== undefined && new Set(rows.columns).size !== rows.columns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["precision"],
        message: "rows.precision requires unique column labels",
      })
    }
    const unknown = Object.keys(rows.precision ?? {}).filter((key) => !rows.columns.includes(key))
    if (unknown.length) {
      ctx.addIssue({
        code: "custom",
        path: ["precision"],
        message: `Unknown rows.precision keys: ${JSON.stringify(unknown)}; available columns: ${JSON.stringify(rows.columns)}`,
      })
    }
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

const basisRequired = `basis is always required: supply one or two sentences, at most ${MAX_BASIS_CHARACTERS} characters, naming population, grain, source object/column, and caveats`

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
    ).describe("One entry per item the request asks for, in the order asked."),
    asked: optional(z.array(z.string())).describe(
      "The items the user's request asks for, in order, as short labels taken from the request (e.g. ['repository', 'most copied file']); name each field or rows column after its item. Never rendered.",
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
      // altimate_change start - trim an over-long basis instead of rejecting the commit (a rejected commit costs a retry turn)
      .transform((value) => {
        if (value.length <= MAX_BASIS_CHARACTERS) return value
        const text = value.trim()
        return text.length <= MAX_BASIS_CHARACTERS ? text : `${text.slice(0, MAX_BASIS_CHARACTERS - 1).trimEnd()}…`
      })
      // altimate_change end
      .describe(
        `basis is always required: one or two sentences, at most ${MAX_BASIS_CHARACTERS} characters, naming population, grain, the source object/column that supplies the requested entity or value, and caveats; never rendered with answer_only`,
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
    ).describe(
      "Required when the request's wording admits more than one reading (population, threshold unit, which status or date column) and you weighed alternatives: one entry whose reading names the chosen interpretation and whose decided_by names the rejected one and why. Recorded only in metadata, never in the answer text",
    ),
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

function limitRenderedAnswer(text: string): string {
  if (text.length > MAX_RENDERED_ANSWER_CHARACTERS) throw new Error(renderedLengthGuidance)
  return text
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
    return limitRenderedAnswer(args.answer_only ? values : `${basis}**Answer:** ${values}`)
  }
  if (args.rows) {
    // altimate_change start - render the requested format before applying the shared size cap
    const { columns, values, precision, format = "markdown" } = args.rows
    // Float noise: more than 6 decimals, yet either a double-precision artifact of, or the exact float32 widening of, a value with at most 6 decimals (0.30000000000000004, 18.440000534057617). Genuine long decimals (1234567.8901234) are not.
    // Two units in the last place of a double: arithmetic artifacts (0.1 + 0.2) sit within it, genuine 15+ digit decimals do not.
    const DOUBLE_ARTIFACT_RELATIVE_ERROR = Number.EPSILON * 2
    // Returns the shortest (at most 6 decimal) value the noisy cell is an artifact of, or undefined for genuine values.
    const artifactOf = (value: number) => {
      const decimal = new Decimal(value)
      if (decimal.decimalPlaces() <= 6) return undefined
      for (let places = 0; places <= 6; places++) {
        const rounded = decimal.toDecimalPlaces(places)
        // Only a double-precision artifact or the exact float32 widening of the rounded value qualifies.
        if (
          Math.fround(rounded.toNumber()) === value ||
          decimal.minus(rounded).abs().lte(decimal.abs().times(DOUBLE_ARTIFACT_RELATIVE_ERROR))
        )
          return rounded
      }
      return undefined
    }
    // Noise contributes the scale of the short value it is an artifact of, never its raw digits.
    const places = (value: number) => (artifactOf(value) ?? new Decimal(value)).decimalPlaces()
    // A column with no ordinary numeric cell keeps its values as given.
    const onlyNoise = columns.map((_, index) => {
      const numbers = values.map((cells) => cells[index]).filter((cell): cell is number => typeof cell === "number")
      return numbers.length > 0 && numbers.every((cell) => artifactOf(cell) !== undefined)
    })
    const scales = columns.map((_, index) =>
      values.reduce((scale, cells) => {
        const value = cells[index]
        return typeof value === "number" ? Math.max(scale, places(value)) : scale
      }, 0),
    )
    const row = (cells: (string | number | null)[]) => {
      if (format === "markdown") return `| ${cells.map(tableCell).join(" | ")} |`
      if (format === "lines") return cells.map(String).join(" ")
      const delimiter = format === "csv" ? "," : "\t"
      return cells
        .map((value) => {
          const cell = value === null ? "" : String(value)
          return cell.includes(delimiter) || /["\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
        })
        .join(delimiter)
    }
    const table = [
      ...(format === "lines" ? [] : [row(columns)]),
      ...(format === "markdown" ? [`|${columns.map(() => "---").join("|")}|`] : []),
      ...values.map((cells) =>
        row(
          cells.map((value, index) => {
            const places =
              precision && Object.hasOwn(precision, columns[index]!) ? precision[columns[index]!] : undefined
            if (typeof value !== "number") return value
            return places !== undefined ? value.toFixed(places) : (onlyNoise[index] ? new Decimal(value).toFixed() : new Decimal(value).toFixed(scales[index]!))
          }),
        ),
      ),
    ].join("\n")
    // altimate_change end
    return limitRenderedAnswer(
      args.answer_only ? table : `${basis}**Answer:**\n${table}${args.rows.note ? `\n${args.rows.note}` : ""}`,
    )
  }
  const unresolved = `unable to determine — ${args.unresolved!.reason}`
  return limitRenderedAnswer(args.answer_only ? unresolved : `${basis}**Answer:** ${unresolved}`)
}

type CommitMetadata = {
  readings: NonNullable<z.output<typeof parameters>["readings"]>
  asked: string[]
  truncated: boolean
  committed_text?: string
}

/**
 * Commit-time checks, each bounded per user turn so a commit is always accepted eventually:
 * every asked item needs its own non-empty field or column (two rejections), and numbers should
 * come from query output (one warning). Earlier rejections are counted from this turn's history.
 */
function commitRejection(
  args: z.output<typeof parameters>,
  messages: Tool.Context["messages"],
): string | undefined {
  if (args.unresolved) return undefined
  const missing = missingAskedItems(args)
  if (missing.length && priorRejections(messages, COVERAGE_REJECTION_MARKER) < MAX_COVERAGE_REJECTIONS)
    return coverageRejection(missing, args.asked!.map((item) => item.trim()).filter(Boolean))
  // altimate_change start - challenge a reading rejected only because it yields a small result
  const sizeBased = sizeBasedRejections(args.readings)
  if (sizeBased.length && priorRejections(messages, READING_REJECTION_MARKER) < MAX_READING_REJECTIONS)
    return readingRejection(sizeBased)
  // altimate_change end
  if (priorRejections(messages, NUMBER_REJECTION_MARKER) >= MAX_NUMBER_REJECTIONS) return undefined
  const seen = sessionNumbers(messages)
  const unsourced = seen ? unsourcedNumbers(args, seen) : []
  return unsourced.length ? numberRejection(unsourced) : undefined
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
    // altimate_change start - expose format selection to the model before the terminal tool call
    description: `Deterministically finalize a data-question answer. Call this as the LAST tool call, once the answer is decided and all queries are finished. After it returns, reply with exactly the returned text and nothing else. Supply exactly one of fields, rows, or unresolved. Supply one field per item the request asks for, in the order asked: a request for 'the repository and the most copied file' needs two fields (one named for the repository, one for the file); never collapse a compound request into one field, and never add fields the request did not ask for. Always set \`asked\` to the requested items, in order, as short labels from the request, and name each field or rows column after its item; a commit that leaves an asked item without its own non-empty value is rejected. When the wording admits more than one reading, add one \`readings\` entry naming the chosen reading and the rejected one; never reject a reading just because it returns few rows. When a sentence lists a related item alongside the entity as something to identify (for example 'the repository and the most copied file'), treat it as asked and commit both; an item that only selects or filters the answer ('the customer with the largest invoice') is not asked. Committed numbers should appear in query output (rounding is fine); compute derived numbers in SQL.Every named item (an entity AND a related item or count) must be its own field, because basis, notes and prose are not shown when the request asks for only the answer; an element found but kept only there is lost. Numbers use JavaScript precision; integers must be safe. Pass exact decimal values, trailing zeros, or currency strings as strings. For fields.precision and each rows.precision value, use an integer from 0 to 10 (inclusive). Set rows.precision by column name to display numeric cells with fixed decimal places, including integers; strings are never changed. Without explicit precision, each column uses the maximum decimal scale of its numeric cells. When the request names a tabular format, set rows.format accordingly: markdown (default), csv, tsv, or lines (one row per line with cells separated by a single space, without headers, for single-column or two-column plain lists). CSV/TSV include headers and quote cells containing the delimiter, quotes, or newlines, doubling embedded quotes; null cells are empty. Always supply \`basis\`; it is never shown when the request asks for only the answer. Supply one or two sentences, at most ${MAX_BASIS_CHARACTERS} characters, naming population, grain, the source object/column that supplies the requested entity or value, and caveats. Resolve policy eligibility separately from metric and entity attribution: a rule about a related object does not change which object supplies the requested entity. Say in \`basis\` which source object and column supply it. When the request names N, rows.values must contain exactly N concrete rows, even with a tie at the top-N boundary; note the tie briefly in rows.note. Use answer_only when the request asks for only the answer or a specific format: the reply is exactly the value(s) or table, with no basis, field names, note, or answer label. An unresolved answer retains its unable-to-determine status. Omit unused optional properties. ${renderedLengthGuidance} This tool is not available for JSON-schema requests; use StructuredOutput instead.`,
    // altimate_change end
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
        const output = renderAnswer(args)
        const rejection = commitRejection(args, ctx.messages ?? [])
        if (rejection) {
          const rejected: Tool.ExecuteResult<CommitMetadata> = {
            title: "Answer not committed",
            metadata: { readings: args.readings ?? [], asked: args.asked ?? [], truncated: false },
            output: rejection,
            status: "error",
          }
          return rejected
        }
        return {
          title: "Answer committed",
          // The processor caps model-facing output but preserves metadata for the final echo.
          metadata: { readings: args.readings ?? [], asked: args.asked ?? [], truncated: false, committed_text: output },
          output,
        }
      }),
  }),
)

export * as AnswerCommit from "./answer-commit"
