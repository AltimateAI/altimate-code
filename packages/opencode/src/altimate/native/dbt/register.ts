/**
 * Register dbt dispatcher methods.
 */

import { register } from "../dispatcher"
import { runDbt } from "./runner"
import { parseManifest } from "./manifest"
import { dbtLineage } from "./lineage"
import { generateDbtUnitTests } from "./unit-tests"
import type {
  DbtRunParams,
  DbtRunResult,
  DbtManifestParams,
  DbtManifestResult,
  DbtLineageParams,
  DbtLineageResult,
  DbtUnitTestGenParams,
  DbtUnitTestGenResult,
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

register("dbt.unit_test_gen", async (params: DbtUnitTestGenParams): Promise<DbtUnitTestGenResult> => {
  return generateDbtUnitTests(params)
})

} // end registerAll

// Auto-register on module load
registerAll()
