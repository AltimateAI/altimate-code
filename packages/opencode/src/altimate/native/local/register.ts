/**
 * Register local testing dispatcher methods.
 */

import { register } from "../dispatcher"
import { syncSchema } from "./schema-sync"
import { testSqlLocal } from "./test-local"
import type {
  LocalSchemaSyncParams,
  LocalSchemaSyncResult,
  LocalTestParams,
  LocalTestResult,
} from "../types"

/** Register all local.* native handlers + ping. Exported for test re-registration. */
export function registerAll(): void {

register("local.schema_sync", async (params: LocalSchemaSyncParams): Promise<LocalSchemaSyncResult> => {
  return syncSchema(params)
})

register("local.test", async (params: LocalTestParams): Promise<LocalTestResult> => {
  return testSqlLocal(params)
})

register("ping", async (): Promise<{ status: string }> => {
  return { status: "ok" }
})

} // end registerAll

// Auto-register on module load
registerAll()
