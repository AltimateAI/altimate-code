import z from "zod"
import { Tool } from "../../tool/tool"

// Strict-schema callers fill unused optional properties with null, "", [] or {}.
// Only optional properties accept these fillers; required values still validate.
function optional<T extends z.ZodType>(schema: T) {
  return z
    .union([schema, z.null(), z.literal(""), z.tuple([]), z.object({}).strict()])
    .optional()
    .transform((value) => {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return undefined
      if (Array.isArray(value) && value.length === 0) return undefined
      if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return undefined
      return value as z.output<T>
    })
}

const field = z
  .object({
    name: z
      .string()
      .refine((value) => value === "" || value.trim().length > 0, "Field name must be non-empty")
      .describe("Field label; use an empty name for an unnamed value"),
    value: z
      .union([z.string(), z.number()], { error: "Each field value must be one non-empty string or number" })
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
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .min(1, "rows.values requires at least one row"),
    note: optional(z.string()),
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

const parameters = z
  .object({
    fields: optional(z.array(field)),
    rows: optional(rows),
    unresolved: optional(
      z
        .object({
          reason: z.string().refine((value) => value.trim().length > 0, "unresolved.reason must be non-empty"),
        })
        .strict(),
    ),
    basis: optional(
      z.string().refine(
        (value) =>
          value
            .replace(/\b(?:e\.g|i\.e|etc|Dr|vs|approx)\./gi, (word) => word.replaceAll(".", ""))
            .split(/[.?!](?:\s+(?=\p{Lu})|$)/u)
            .filter((part) => part.trim()).length <= 2,
        "basis must contain at most 2 sentences",
      ),
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

function validationError(error: z.ZodError): string {
  const describe = (issues: z.core.$ZodIssue[], parent: PropertyKey[] = []): string[] =>
    issues.flatMap((issue) => {
      const path = [...parent, ...issue.path]
      // The first union member is the actual value schema; the others are fillers.
      if (issue.code === "invalid_union" && issue.errors[0]?.length && !issue.message.includes("Each field value"))
        return describe(issue.errors[0], path)
      return [`${path.join(".") || "answer_commit"}: ${issue.message}`]
    })
  return describe(error.issues).join("; ")
}

function tableCell(value: string | number | null): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, " ")
}

/** Deterministically finalize a data-question answer without changing session state. */
export function renderAnswer(payload: unknown): string {
  const parsed = parameters.safeParse(payload)
  if (!parsed.success) throw new Error(validationError(parsed.error))
  const args = parsed.data
  const basis = !args.answer_only && args.basis ? `${args.basis}\n\n` : ""
  if (args.fields) {
    const values = args.fields
      .map((field) => {
        const value =
          typeof field.value === "number" && field.precision !== undefined && !Number.isInteger(field.value)
            ? field.value.toFixed(field.precision)
            : String(field.value)
        const name = !args.answer_only && field.name ? `${field.name}: ` : ""
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
  return `${basis}**Answer:** unable to determine — ${args.unresolved!.reason}`
}

export const AnswerCommitTool = Tool.define("answer_commit", {
  description:
    "Deterministically finalize a data-question answer. Call this as the LAST tool call, once the answer is decided and all queries are finished. Use the returned answer text verbatim as your final reply, following the reply instruction. Supply exactly one of fields, rows, or unresolved. Use answer_only when the request asks for only the answer or a specific format: the reply is exactly the value(s) or table, with no basis, field names, note, or answer label. An unresolved answer retains its unable-to-determine status. Omit unused optional properties. In JSON-schema mode, this tool is not automatically removed when a user output schema is set; the user schema takes precedence.",
  parameters,
  formatValidationError: validationError,
  async execute(args, ctx) {
    if (ctx.agent !== "analyst") throw new Error("answer_commit is only available to the analyst agent")
    await ctx.ask({ permission: "answer_commit", patterns: ["*"], always: ["*"], metadata: {} })
    return {
      title: "Answer committed",
      metadata: { readings: args.readings ?? [], truncated: false },
      output: `${renderAnswer(args)}\n\nReply with exactly the text above and nothing else.`,
    }
  },
})
