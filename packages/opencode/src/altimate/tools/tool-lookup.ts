import z from "zod"
import { Effect } from "effect"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Tool } from "../../tool/tool"
import { ToolRegistry } from "../../tool/registry"

export const ToolLookupTool = Tool.define("tool_lookup", {
  description:
    "Look up any tool's description, parameters, and types. " +
    "Call with a tool name to see its full contract before using it.",
  parameters: z.object({
    tool_name: z.string().describe("Exact tool ID (e.g., 'sql_analyze', 'altimate_core_migration')"),
  }),
  async execute(args) {
    const infos = await ToolRegistry.allInfos()
    const info = infos.find((t) => t.id === args.tool_name)
    if (!info) {
      const ids = infos.map((t) => t.id).sort()
      return {
        title: "Tool not found",
        metadata: {},
        output: `No tool named "${args.tool_name}". Available tools:\n${ids.join(", ")}`,
      }
    }

    // Upstream's Tool rewrite made `init()` an Effect (was a Promise) and `parameters`
    // an Effect Schema (was a zod schema). Describe from the JSON Schema instead — it's
    // populated for both native tools and our legacy zod tools (via tool-zod-compat).
    const tool = await Effect.runPromise(info.init())
    const params = describeJsonSchema(tool.jsonSchema)
    const lines = [info.id, `  ${tool.description}`, ""]
    if (params.length) {
      lines.push("  Parameters:")
      for (const p of params) {
        const req = p.required ? "required" : "optional"
        const desc = p.description ? ` — ${p.description}` : ""
        lines.push(`    ${p.name}  (${p.type}, ${req})${desc}`)
      }
    } else {
      lines.push("  No parameters.")
    }

    return { title: `Lookup: ${info.id}`, metadata: {}, output: lines.join("\n") }
  },
})

interface ParamInfo {
  name: string
  type: string
  required: boolean
  description: string
}

function describeJsonSchema(schema: JSONSchema7 | undefined): ParamInfo[] {
  if (!schema || typeof schema !== "object") return []
  const properties = schema.properties
  if (!properties) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])

  const params: ParamInfo[] = []
  for (const [name, field] of Object.entries(properties)) {
    if (typeof field !== "object") continue
    params.push({
      name,
      type: inferJsonType(field),
      required: required.has(name),
      description: typeof field.description === "string" ? field.description : "",
    })
  }
  return params
}

/** Render a JSON Schema fragment as a short human-readable type string. */
function inferJsonType(field: JSONSchema7Definition): string {
  if (typeof field !== "object" || field === null) return "unknown"
  // enum / const literals first — most specific.
  if (Array.isArray(field.enum)) return `enum(${field.enum.map((v) => JSON.stringify(v)).join("|")})`
  if ("const" in field && field.const !== undefined) return JSON.stringify(field.const)
  // anyOf/oneOf unions (zod optionals/unions land here).
  const union = field.anyOf ?? field.oneOf
  if (Array.isArray(union)) {
    const parts = union.map((o) => inferJsonType(o)).filter((t) => t !== "unknown" && t !== "null")
    if (parts.length) return parts.join(" | ")
  }
  const type = Array.isArray(field.type) ? field.type.find((t) => t !== "null") : field.type
  if (type === "array") {
    const items = Array.isArray(field.items) ? field.items[0] : field.items
    return `array<${items ? inferJsonType(items) : "unknown"}>`
  }
  if (type === "object") return field.additionalProperties ? "record" : "object"
  if (typeof type === "string") return type
  return "unknown"
}
