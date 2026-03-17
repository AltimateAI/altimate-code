/**
 * Register all finops dispatcher methods.
 */

import { register } from "../dispatcher"
import { getQueryHistory } from "./query-history"
import { analyzeCredits, getExpensiveQueries } from "./credit-analyzer"
import { adviseWarehouse } from "./warehouse-advisor"
import { findUnusedResources } from "./unused-resources"
import { queryGrants, queryRoleHierarchy, queryUserRoles } from "./role-access"
import type {
  QueryHistoryParams,
  QueryHistoryResult,
  CreditAnalysisParams,
  CreditAnalysisResult,
  ExpensiveQueriesParams,
  ExpensiveQueriesResult,
  WarehouseAdvisorParams,
  WarehouseAdvisorResult,
  UnusedResourcesParams,
  UnusedResourcesResult,
  RoleGrantsParams,
  RoleGrantsResult,
  RoleHierarchyParams,
  RoleHierarchyResult,
  UserRolesParams,
  UserRolesResult,
} from "../types"

/** Register all finops.* native handlers. Exported for test re-registration. */
export function registerAll(): void {

register("finops.query_history", async (params: QueryHistoryParams): Promise<QueryHistoryResult> => {
  return getQueryHistory(params)
})

register("finops.analyze_credits", async (params: CreditAnalysisParams): Promise<CreditAnalysisResult> => {
  return analyzeCredits(params)
})

register("finops.expensive_queries", async (params: ExpensiveQueriesParams): Promise<ExpensiveQueriesResult> => {
  return getExpensiveQueries(params)
})

register("finops.warehouse_advice", async (params: WarehouseAdvisorParams): Promise<WarehouseAdvisorResult> => {
  return adviseWarehouse(params)
})

register("finops.unused_resources", async (params: UnusedResourcesParams): Promise<UnusedResourcesResult> => {
  return findUnusedResources(params)
})

register("finops.role_grants", async (params: RoleGrantsParams): Promise<RoleGrantsResult> => {
  return queryGrants(params)
})

register("finops.role_hierarchy", async (params: RoleHierarchyParams): Promise<RoleHierarchyResult> => {
  return queryRoleHierarchy(params)
})

register("finops.user_roles", async (params: UserRolesParams): Promise<UserRolesResult> => {
  return queryUserRoles(params)
})

} // end registerAll

// Auto-register on module load
registerAll()
