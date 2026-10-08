/**
 * `tool_run`: the one fixed tool through which a tool outside the offered list is called.
 *
 * Its definition (name, schema, and the index of reachable tools) is fixed for the whole session, so
 * reaching a hidden tool never changes the tool block of the prompt (see tool-selection.ts).
 */
import { tool, jsonSchema, asSchema, type Tool as AITool } from "ai"
import { Log } from "@/util/log"
import { ToolLookup } from "./tools/tool-lookup"
import { ToolSelection } from "./tool-selection"

const log = Log.create({ service: "tool.run" })

/** Calls the model addressed to a hidden tool directly, which were rerouted here instead of failing. */
const rerouted = new Set<string>()
export function markRerouted(toolCallId: string) {
  // A rerouted call that never executes (an abort) would leave its id behind; keep the set small.
  if (rerouted.size > 1000) rerouted.clear()
  rerouted.add(toolCallId)
}

function contract(target: AITool): string {
  try {
    const schema = (asSchema(target.inputSchema) as { jsonSchema: any }).jsonSchema
    const params = ToolLookup.describeJsonSchema(schema)
    if (params.length === 0) return "No parameters."
    return params
      .map((p) => `  ${p.name}  (${p.type}, ${p.required ? "required" : "optional"})${p.description ? ` ${p.description}` : ""}`)
      .join("\n")
  } catch {
    return "Use tool_lookup to see the parameters."
  }
}

export function createRunTool(input: {
  hidden: Record<string, AITool>
}): AITool {
  const names = Object.keys(input.hidden)
  const run = tool({
    description: ToolSelection.runDescription(names),
    inputSchema: jsonSchema<{ name?: unknown; arguments?: unknown }>({
      type: "object",
      properties: {
        name: { type: "string", description: "Exact name of the tool to run" },
        arguments: { type: "object", description: "The tool's own parameters", additionalProperties: true },
      },
      required: ["name"],
    }),
    async execute(args: { name?: unknown; arguments?: unknown }, options) {
      const name = typeof args.name === "string" ? args.name.trim() : ""
      const params: unknown = args.arguments === undefined ? {} : args.arguments
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new Error(`tool_run: "arguments" must be an object holding the tool's parameters.`)
      }
      const target = Object.hasOwn(input.hidden, name) ? input.hidden[name] : undefined
      if (!target?.execute) {
        throw new Error(
          name === ""
            ? `tool_run needs a tool name. Available through tool_run: ${names.join(", ")}`
            : `No tool named "${name}" is available through tool_run. Available: ${names.join(", ")}. ` +
                `Tools in your own tool list are called directly.`,
        )
      }
      // The permission deny for a governed tool is enforced inside the target's own wrapper (session/prompt.ts),
      // after the call's execution has been registered, so a refusal pairs with its call even when a provider
      // repeats call ids.
      const wasRerouted = options.toolCallId ? rerouted.delete(options.toolCallId) : false
      log.info("run", { tool: name, rerouted: wasRerouted })
      try {
        const result = (await target.execute(params as never, options)) as { metadata?: Record<string, unknown> }
        if (result && typeof result === "object") {
          return { ...result, metadata: { ...result.metadata, tool_run: name, ...(wasRerouted ? { rerouted: true } : {}) } }
        }
        return result
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (/invalid arguments/i.test(message)) throw new Error(`${message}\n\nParameters of ${name}:\n${contract(target)}`)
        throw e
      }
    },
  })
  ToolSelection.attachHidden(run, input.hidden)
  return run
}

export * as ToolRun from "./tool-run"
