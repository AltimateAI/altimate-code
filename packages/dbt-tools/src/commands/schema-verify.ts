import type { ColumnMetaData, DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

/**
 * Verify that a model's actual produced columns match the spec declared in
 * `schema.yml` (compiled into manifest.json as `node.columns`).
 *
 * Spec source: `adapter.nodeMetaMap.lookupByBaseName(model).columns` — these
 * are the columns the schema.yml entry promised. Object insertion order is
 * preserved through manifest parsing, so it carries the spec's column order.
 *
 * Actual source: `adapter.getColumnsOfModel(model)` — the columns the
 * warehouse / catalog reports the materialized table actually has.
 *
 * Returns four lists the agent must treat as the contract:
 *   - columns_extra:     in actual, not in spec   → REMOVE from SELECT
 *   - columns_missing:   in spec, not in actual   → ADD to SELECT
 *   - columns_reordered: in both, wrong position  → REORDER the SELECT
 *   - type_mismatches:   same name, different declared types
 *
 * `verdict` is "match" iff all four lists are empty.
 *
 * Skip cases:
 *   - "no-spec": schema.yml doesn't declare columns for this model — nothing
 *     to verify; agent has no contract to fail against.
 */
export async function schemaVerify(adapter: DBTProjectIntegrationAdapter, args: string[]) {
  const model = flag(args, "model")
  if (!model) return { error: "Missing --model" }

  // 1. Expected columns from schema.yml (via parsed manifest's NodeMetaMap)
  const parsed = await adapter.parseManifest()
  const node = parsed?.nodeMetaMap.lookupByBaseName(model)
  if (!node) {
    return {
      error: `Model '${model}' not found in manifest. Did you run \`altimate-dbt compile\` or \`altimate-dbt build\` first?`,
    }
  }

  const expectedEntries: ColumnMetaData[] = Object.values((node.columns ?? {}) as Record<string, ColumnMetaData>)

  // 2. Actual columns from the materialized table (warehouse via adapter)
  let actual
  try {
    actual = await adapter.getColumnsOfModel(model)
  } catch (e) {
    return {
      error: `Failed to read actual columns for '${model}': ${e instanceof Error ? e.message : String(e)}. Build the model first: altimate-dbt build --model ${model}`,
    }
  }
  if (!actual) {
    return {
      error: `Model '${model}' is in the manifest but has no warehouse table. Build it first: altimate-dbt build --model ${model}`,
    }
  }

  // 3. Special case: schema.yml declares no columns for this model
  if (expectedEntries.length === 0) {
    return {
      model,
      verdict: "no-spec" as const,
      message: `Model '${model}' has no columns declared in schema.yml. There is no spec to verify against; the agent's column choices are unconstrained.`,
      actual_columns: actual.map((c) => c.column),
    }
  }

  // 4. Diff — case-insensitive name comparison (dbt convention)
  const actualNames: string[] = actual.map((c) => c.column ?? "")
  const actualLower: string[] = actualNames.map((n) => n.toLowerCase())
  const expectedNames: string[] = expectedEntries.map((c) => c.name ?? "")
  const expectedLower: string[] = expectedNames.map((n) => n.toLowerCase())

  const actualSet = new Set(actualLower)
  const expectedSet = new Set(expectedLower)

  const columns_extra: string[] = []
  for (let i = 0; i < actualNames.length; i++) {
    const low = actualLower[i] ?? ""
    const orig = actualNames[i] ?? ""
    if (!expectedSet.has(low)) columns_extra.push(orig)
  }

  const columns_missing: string[] = []
  for (let i = 0; i < expectedNames.length; i++) {
    const low = expectedLower[i] ?? ""
    const orig = expectedNames[i] ?? ""
    if (!actualSet.has(low)) columns_missing.push(orig)
  }

  // Reordered: present in both sets but at different positions in the ordered lists.
  // Compare positions within the intersection (so missing/extra don't shift indices).
  const intersection: string[] = expectedLower.filter((n) => actualSet.has(n))
  const actualIntersection: string[] = actualLower.filter((n) => expectedSet.has(n))
  const columns_reordered: Array<{ column: string; actual_position: number; expected_position: number }> = []
  for (let i = 0; i < intersection.length; i++) {
    const expectedAtI = intersection[i] ?? ""
    const actualAtI = actualIntersection[i] ?? ""
    if (expectedAtI !== actualAtI) {
      const colLower = expectedAtI
      const actualIdx = actualLower.indexOf(colLower)
      // Use the originally-cased name from expected for the report
      const expectedPos = expectedLower.indexOf(colLower)
      const original = expectedNames[expectedPos] ?? colLower
      columns_reordered.push({
        column: original,
        actual_position: actualIdx,
        expected_position: expectedPos,
      })
    }
  }

  // Type mismatches: declared `data_type` in schema.yml vs dtype reported by warehouse.
  // Skip cases where the spec didn't declare a data_type (common — most schema.yml
  // entries omit it). Comparison is case-insensitive on the type string.
  const actualTypeByName: Record<string, string> = {}
  for (const c of actual) actualTypeByName[c.column.toLowerCase()] = c.dtype || ""
  const type_mismatches: Array<{ column: string; actual_type: string; expected_type: string }> = []
  for (const ec of expectedEntries) {
    const key = ec.name.toLowerCase()
    if (!actualTypeByName[key]) continue
    if (!ec.data_type) continue
    if (actualTypeByName[key].toLowerCase() !== ec.data_type.toLowerCase()) {
      type_mismatches.push({
        column: ec.name,
        actual_type: actualTypeByName[key],
        expected_type: ec.data_type,
      })
    }
  }

  const verdict =
    columns_extra.length === 0 &&
    columns_missing.length === 0 &&
    columns_reordered.length === 0 &&
    type_mismatches.length === 0
      ? ("match" as const)
      : ("mismatch" as const)

  return {
    model,
    verdict,
    expected_columns: expectedNames,
    actual_columns: actualNames,
    columns_extra,
    columns_missing,
    columns_reordered,
    type_mismatches,
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
