/**
 * Register dbt dispatcher methods.
 */

import { register } from "../dispatcher"
import { runDbt } from "./runner"
import { parseManifest } from "./manifest"
import { dbtLineage } from "./lineage"
import type {
  DbtRunParams,
  DbtRunResult,
  DbtManifestParams,
  DbtManifestResult,
  DbtLineageParams,
  DbtLineageResult,
} from "../types"

/** Register all dbt.* native handlers. Exported for test re-registration. */
export function registerAll(): void {

register("dbt.run", async (params: DbtRunParams): Promise<DbtRunResult> => {
  return runDbt(params)
})

register("dbt.manifest", async (params: DbtManifestParams): Promise<DbtManifestResult> => {
  return parseManifest(params)
})

register("dbt.lineage", async (params: DbtLineageParams): Promise<DbtLineageResult> => {
  return dbtLineage(params)
})

} // end registerAll

// Auto-register on module load
registerAll()
