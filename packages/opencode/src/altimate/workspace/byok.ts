// altimate_change - new file
import { AltimateApi } from "../api/client"
import { WorkspaceApi } from "./api-client"
import { resolveBinding } from "./state"

export namespace WorkspaceByok {
  /** Marks a request as running on the workspace's own model key, so the gateway does not count it
   * against Altimate tokens. */
  export const HEADERS: Record<string, string> = { "x-altimate-byok": "true" }

  /** The linked workspace's model key for this directory, or undefined for today's behaviour.
   * The key is held in memory for the provider options only; it is never logged or written. */
  export async function resolve(directory: string): Promise<{ apiKey: string } | undefined> {
    try {
      if (!(await AltimateApi.isConfigured())) return undefined
      const binding = await resolveBinding(directory)
      if (!binding) return undefined
      const apiKey = await WorkspaceApi.getModelKey(binding.datamateId)
      return apiKey ? { apiKey } : undefined
    } catch {
      return undefined
    }
  }
}
