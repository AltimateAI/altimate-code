// altimate_change - new file
import { AltimateApi } from "../api/client"
import { WorkspaceApi } from "./api-client"
import { resolveBinding } from "./state"

/** The linked workspace's model keys for this directory, by provider id; empty for today's behaviour.
 * The keys are held in memory for the provider options only; they are never logged or written. */
export async function resolve(directory: string): Promise<Record<string, string>> {
  try {
    const actAs = await WorkspaceApi.captureCredentials()
    if (!actAs) return {}
    const binding = await resolveBinding(directory)
    if (!binding) return {}
    return await WorkspaceApi.getModelKeys(binding.datamateId, actAs)
  } catch {
    return {}
  }
}

export * as WorkspaceByok from "./byok"
