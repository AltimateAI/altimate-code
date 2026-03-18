import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"
import { execDbtLs } from "../dbt-cli"

export async function children(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  try {
    return await adapter.getChildrenModels({ table: model })
  } catch (e) {
    // nodeMetaMap/graphMetaMap errors are specific to the library's manifest parsing.
    // Also catch TypeError for property-access failures on undefined nodes.
    if (
      e instanceof TypeError ||
      (e instanceof Error && (e.message.includes("nodeMetaMap has no entries") || e.message.includes("graphMetaMap")))
    ) {
      return execDbtLs(model, "children")
    }
    throw e
  }
}

export async function parents(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }
  try {
    return await adapter.getParentModels({ table: model })
  } catch (e) {
    if (
      e instanceof TypeError ||
      (e instanceof Error && (e.message.includes("nodeMetaMap has no entries") || e.message.includes("graphMetaMap")))
    ) {
      return execDbtLs(model, "parents")
    }
    throw e
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
