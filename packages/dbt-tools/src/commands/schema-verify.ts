import type { ColumnMetaData, DBTProjectIntegrationAdapter, TestMetaData } from "@altimateai/dbt-integration"

/**
 * Compare a model's materialized columns with the columns its YAML declares
 * (`node.columns` in the manifest) and report only what dbt's own semantics
 * establish.
 *
 * What YAML `columns:` means in dbt:
 *   - Without an enforced contract it is documentation plus the anchor for
 *     column tests. It is NOT an exhaustive list: models routinely produce
 *     columns the YAML never mentions, so "produced but not listed" says
 *     nothing about whether a column is wanted.
 *   - With `config.contract.enforced: true`, dbt itself requires the model to
 *     return exactly the declared columns and rejects the build otherwise.
 *   - A declared column the model does not produce is a real problem when a
 *     test is attached to it (the test reads a column that is not there), and
 *     when a contract is enforced. With neither, it is a stale or aspirational
 *     entry: worth knowing, not a failure.
 *   - Column order in YAML never constrains the model (dbt aligns it itself
 *     under a contract), and `data_type` is only checked by dbt under a contract
 *     (adapters spell types differently, so string comparison is not evidence).
 *
 * Output:
 *   - verdict "mismatch" iff `findings` is non-empty. Each finding names what is
 *     wrong, the YAML file that declares it, and why it is established.
 *   - `notes` carry true observations that are not problems (unlisted columns,
 *     declared-but-absent columns nothing depends on, type differences).
 *   - `columns_extra` / `columns_missing` / `columns_reordered` /
 *     `type_mismatches` are the raw diff against the YAML, for transparency. They
 *     are not instructions: `columns_extra` means "not listed in YAML".
 *   - verdict "no-spec": the model has no columns declared in YAML.
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
      message: `Model '${model}' has no columns declared in YAML. There is no declaration to compare against.`,
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

  // 5. Decide what is established (see header). Raw diff lists above are kept as-is.
  const contractEnforced = isContractEnforced(node as unknown as Record<string, unknown>)
  const { file: declaredIn, pkg: declaredPackage } = splitPatchPath(node.patch_path)
  const where = describeSource(declaredIn, declaredPackage, node.package_name)
  // Scanning every test of the project is only needed when a declared column is missing.
  const testsByColumn = !contractEnforced && columns_missing.length > 0 ? columnTests(parsed?.testMetaMap, node.unique_id) : new Map<string, string[]>()

  const findings: Finding[] = []
  const notes: string[] = []

  const listed = (names: string[]) => names.map((n) => `\`${n}\``).join(", ")

  if (contractEnforced) {
    if (columns_missing.length > 0)
      findings.push({
        kind: "contract-missing-columns",
        columns: columns_missing,
        evidence: `${where} declares an enforced contract that lists ${listed(columns_missing)}, but the built table does not have ${columns_missing.length === 1 ? "it" : "them"}. dbt rejects a contract-enforced model whose columns differ from the contract.`,
      })
    if (columns_extra.length > 0)
      findings.push({
        kind: "contract-extra-columns",
        columns: columns_extra,
        evidence: `${where} declares an enforced contract that does not list ${listed(columns_extra)}, but the built table has ${columns_extra.length === 1 ? "it" : "them"}. dbt rejects a contract-enforced model whose columns differ from the contract.`,
      })
  } else {
    const missingWithTests = columns_missing.filter((c) => (testsByColumn.get(c.toLowerCase()) ?? []).length > 0)
    const missingUntested = columns_missing.filter((c) => !missingWithTests.includes(c))
    if (missingWithTests.length > 0) {
      const detail = missingWithTests
        .map((c) => `\`${c}\` (tests: ${(testsByColumn.get(c.toLowerCase()) ?? []).join(", ")})`)
        .join("; ")
      findings.push({
        kind: "tested-column-missing",
        columns: missingWithTests,
        evidence: `${where} declares column(s) with tests attached that the built table does not have: ${detail}. Those tests read a column that does not exist.`,
      })
    }
    if (missingUntested.length > 0)
      notes.push(
        `${where} declares ${listed(missingUntested)}, which the built table does not have. No test or contract depends on ${missingUntested.length === 1 ? "it" : "them"}, so this may be a stale or aspirational YAML entry rather than a defect in the model.`,
      )
    if (columns_extra.length > 0)
      notes.push(
        `The built table has ${listed(columns_extra)}, not listed in ${where}. dbt does not require YAML to list every column, so this is not an error.`,
      )
  }
  if (type_mismatches.length > 0 && contractEnforced)
    notes.push(
      `Declared data_type differs from the warehouse type for ${listed(type_mismatches.map((t) => t.column))}; dbt compares types itself when it builds a contract-enforced model and rejects a real violation, so confirm with a build rather than from this string comparison (adapters spell types differently).`,
    )

  const verdict = findings.length === 0 ? ("match" as const) : ("mismatch" as const)

  return {
    model,
    verdict,
    spec: { declared_in: declaredIn, package: declaredPackage ?? node.package_name, contract_enforced: contractEnforced },
    expected_columns: expectedNames,
    actual_columns: actualNames,
    columns_extra,
    columns_missing,
    columns_reordered,
    type_mismatches,
    findings,
    notes,
  }
}

export interface Finding {
  kind: "contract-missing-columns" | "contract-extra-columns" | "tested-column-missing"
  columns: string[]
  /** Which YAML declares what, and why this is a problem. */
  evidence: string
}

function isContractEnforced(node: Record<string, unknown>): boolean {
  const fromConfig = (node.config as { contract?: { enforced?: unknown } } | undefined)?.contract?.enforced
  const fromNode = (node.contract as { enforced?: unknown } | undefined)?.enforced
  return fromConfig === true || fromNode === true
}

/** dbt's `patch_path` looks like `<package>://<path relative to that package>`. */
function splitPatchPath(patchPath: string | undefined): { file?: string; pkg?: string } {
  if (!patchPath) return {}
  const m = /^([^:/]+):\/\/(.*)$/.exec(patchPath)
  return m ? { pkg: m[1], file: m[2] } : { file: patchPath }
}

function describeSource(file: string | undefined, declaringPackage: string | undefined, modelPackage: string | undefined): string {
  const f = file ? `\`${file}\`` : "the YAML entry"
  if (declaringPackage && modelPackage && declaringPackage !== modelPackage)
    return `${f} in package \`${declaringPackage}\` (not this project)`
  return f
}

/** Lower-cased column name -> names of tests attached to that column of the model. */
function columnTests(testMetaMap: Map<string, TestMetaData> | undefined, modelUniqueId: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!testMetaMap || typeof testMetaMap.entries !== "function") return out
  for (const [name, t] of testMetaMap.entries()) {
    // Manifests before dbt 1.5 have no `attached_node`; the tested model is then a model dependency.
    const attached =
      t.attached_node ??
      (t as TestMetaData & { depends_on?: { nodes?: string[] } }).depends_on?.nodes?.find((id) => id.startsWith("model."))
    if (attached !== modelUniqueId || !t.column_name) continue
    const key = t.column_name.toLowerCase()
    out.set(key, [...(out.get(key) ?? []), name])
  }
  return out
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
