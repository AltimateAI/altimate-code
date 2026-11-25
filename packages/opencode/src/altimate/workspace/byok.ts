// altimate_change - new file
import { AltimateApi } from "../api/client"
import { WorkspaceApi } from "./api-client"
import { readLocalBinding } from "./state"

/** The linked workspace's model keys for this directory, by provider id; empty for today's behaviour.
 * Reads the local link record only, so no workspace call or pin check is made for it. The keys are held in memory for the provider options only; they are never logged or written. */
export async function resolve(directory: string): Promise<Record<string, string>> {
  try {
    const actAs = await WorkspaceApi.captureCredentials()
    if (!actAs) return {}
    const binding = await readLocalBinding(directory)
    if (!binding) return {}
    return await WorkspaceApi.getModelKeys(binding.datamateId, actAs)
  } catch {
    return {}
  }
}

export * as WorkspaceByok from "./byok"
