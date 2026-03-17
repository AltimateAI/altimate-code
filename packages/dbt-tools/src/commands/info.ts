import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

export async function info(adapter: DBTProjectIntegrationAdapter) {
  return adapter.getProjectInfo()
}
