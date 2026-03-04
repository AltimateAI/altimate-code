import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreFingerprintTool = Tool.define("altimate_core_fingerprint", {
  description:
    "Compute a SHA-256 fingerprint of a schema using the Rust-based altimate-core engine. Useful for cache invalidation and change detection.",
  parameters: z.object({
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.fingerprint", {
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Fingerprint: ${data.fingerprint?.substring(0, 12) ?? "computed"}...`,
        metadata: { success: result.success, fingerprint: data.fingerprint },
        output: `SHA-256: ${data.fingerprint ?? "unknown"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Fingerprint: ERROR", metadata: { success: false, fingerprint: null }, output: `Failed: ${msg}` }
    }
  },
})
