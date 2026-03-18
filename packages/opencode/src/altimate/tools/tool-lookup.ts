import z from "zod"
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

    const tool = await info.init()
    const params = describeZodSchema(tool.parameters)
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

function describeZodSchema(schema: z.ZodType): ParamInfo[] {
  const shape = getShape(schema)
  if (!shape) return []

  const params: ParamInfo[] = []
  for (const [name, field] of Object.entries<any>(shape)) {
    const unwrapped = unwrap(field)
    params.push({
      name,
      type: inferZodType(field),
      required: !field.isOptional(),
      description: unwrapped.description ?? field.description ?? "",
    })
  }
  return params
}

function getShape(schema: any): Record<string, any> | null {
  if (schema?._def?.shape) {
    return typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape
  }
  if (schema?._def?.innerType) return getShape(schema._def.innerType)
  return null
}

/** Unwrap optional/default wrappers to reach the inner type. */
function unwrap(field: any): any {
  const type = field?._def?.type
  if (type === "optional" || type === "default" || type === "nullable") {
    return field._def.innerType ? unwrap(field._def.innerType) : field
  }
  return field
}

function inferZodType(field: any): string {
  const type: string = field?._def?.type ?? ""
  if (type === "optional" || type === "default" || type === "nullable") {
    return field._def.innerType ? inferZodType(field._def.innerType) : "unknown"
  }
  if (type === "string") return "string"
  if (type === "number") return "number"
  if (type === "boolean") return "boolean"
  if (type === "array") return `array<${inferZodType(field._def.element)}>`
  if (type === "enum") return `enum(${field.options?.join("|") ?? Object.keys(field._def.entries ?? {}).join("|")})`
  if (type === "record") return "record"
  if (type === "object") return "object"
  if (type === "union") return field._def.options?.map((o: any) => inferZodType(o)).join(" | ") ?? "union"
  if (type === "literal") return JSON.stringify(field._def.value)
  if (type === "any") return "any"
  if (type === "unknown") return "unknown"
  // Fallback: use constructor name or _def.type
  return type || field?.constructor?.name?.replace("Zod", "").toLowerCase() || "unknown"
}
