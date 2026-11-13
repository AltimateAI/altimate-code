import YAML from "yaml"
import { makeFinding, type Finding } from "./finding"
import type { ChangedFile, DbtProjectLayout } from "./diff-filter"

/**
 * Data tests that cannot do their job, found from yml alone (any adapter):
 *  - a test that compares a model with itself (`dbt_utils.equality` /
 *    `equal_rowcount` against its own `ref`, or a `relationships` test pointing
 *    at its own column) passes by construction;
 *  - tests added in the PR that inherit `severity: warn` (or an `error_if`
 *    threshold) from `dbt_project.yml` report failures without failing the build;
 *  - a PR that loosens those thresholds in `dbt_project.yml` weakens every test
 *    under that path.
 * Only tests added or changed in the PR are checked.
 */

interface TestRef {
  entity: string
  column?: string
  test: string
  args: Record<string, any>
}

const SELF_COMPARE = new Set([
  "equality",
  "equal_rowcount",
  "cardinality_equality",
  "fewer_rows_than",
  "expect_table_row_count_to_equal_other_table",
  "expect_table_aggregation_to_equal_other_table",
])

function parse(text?: string): any {
  if (!text) return undefined
  try {
    return YAML.parse(text)
  } catch {
    return undefined
  }
}

function testsOf(doc: any): TestRef[] {
  const out: TestRef[] = []
  const read = (list: unknown, entity: string, column?: string) => {
    if (!Array.isArray(list)) return
    for (const t of list) {
      if (typeof t === "string") out.push({ entity, column, test: t, args: {} })
      else if (t && typeof t === "object") {
        const [k] = Object.keys(t)
        if (k) out.push({ entity, column, test: k, args: (t as any)[k] ?? {} })
      }
    }
  }
  for (const group of ["models", "snapshots", "seeds"]) {
    for (const e of Array.isArray(doc?.[group]) ? doc[group] : []) {
      if (typeof e?.name !== "string") continue
      read(e.data_tests ?? e.tests, e.name)
      for (const c of Array.isArray(e.columns) ? e.columns : [])
        if (typeof c?.name === "string") read(c.data_tests ?? c.tests, e.name, c.name)
    }
  }
  return out
}

const key = (t: TestRef) => `${t.entity}|${t.column ?? ""}|${t.test}|${JSON.stringify(t.args)}`
const arg = (t: TestRef, name: string) => t.args?.[name] ?? t.args?.arguments?.[name]
const shortName = (test: string) => test.split(".").pop()!.toLowerCase()
const refsEntity = (v: unknown, entity: string) =>
  typeof v === "string" && new RegExp(`ref\\(\\s*['"]${entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]\\s*\\)`).test(v)

function finding(file: ChangedFile, model: string | undefined, rule: string, severity: Finding["severity"], title: string, body: string, extra = ""): Finding {
  return makeFinding({
    severity,
    category: "test_coverage",
    title,
    body,
    file: file.path,
    model,
    confidence: "high",
    evidence: { tool: "test-adequacy", result: { rule } },
    ruleKey: `test_coverage:${rule}${extra}`,
  })
}

/** `+severity` / `+error_if` / `+warn_if` (with or without `+`) on one config node. */
function thresholds(node: any): { severity?: string; error_if?: string; warn_if?: string } {
  if (!node || typeof node !== "object") return {}
  const get = (k: string) => (node[`+${k}`] ?? node[k]) as unknown
  const str = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : undefined)
  return { severity: str(get("severity")), error_if: str(get("error_if")), warn_if: str(get("warn_if")) }
}

/**
 * Effective test thresholds for a yml under `segments` (folders below the model
 * path), walking `data_tests:` (or `tests:`) from the top, through the project
 * name, down the folders; deeper levels override. `path` is where the effective
 * value was set.
 */
export function inheritedThresholds(projectYml: any, segments: string[]): { severity?: string; error_if?: string; path: string[] } {
  const tree = projectYml?.data_tests ?? projectYml?.tests
  if (!tree || typeof tree !== "object") return { path: [] }
  const name = projectYml?.name
  const chain = name && tree[name] && typeof tree[name] === "object" ? [String(name), ...segments] : segments
  const levels: Array<[string[], any]> = [[[], tree]]
  let node = tree
  for (let i = 0; i < chain.length; i++) {
    node = node?.[chain[i]]
    if (!node || typeof node !== "object") break
    levels.push([chain.slice(0, i + 1), node])
  }
  const eff: { severity?: string; error_if?: string } = {}
  let path: string[] = []
  for (const [at, n] of levels) {
    const t = thresholds(n)
    if (t.severity) eff.severity = t.severity
    if (t.error_if) eff.error_if = t.error_if
    if (t.severity || t.error_if) path = at.length ? at : ["(all tests)"]
  }
  return { ...eff, path }
}

/** Folders of a yml below its model path (e.g. `models/marts/x.yml` → `["marts"]`). */
function segmentsOf(file: string, layout?: DbtProjectLayout): string[] {
  const root = layout?.root ? layout.root.replace(/\/$/, "") + "/" : ""
  const rel = root && file.startsWith(root) ? file.slice(root.length) : file
  const parts = rel.split("/").slice(0, -1)
  const modelDirs = layout?.dirs.model ?? ["models"]
  return modelDirs.includes(parts[0]) ? parts.slice(1) : parts
}

export function detectTestAdequacy(input: {
  file: ChangedFile
  oldContent?: string
  newContent?: string
  projectYml?: string
  layout?: DbtProjectLayout
}): Finding[] {
  const { file } = input
  if (file.status === "deleted") return []
  const newDoc = parse(input.newContent)
  if (!newDoc) return []
  const before = new Set(testsOf(parse(input.oldContent)).map(key))
  const added = testsOf(newDoc).filter((t) => !before.has(key(t)))
  const out: Finding[] = []

  for (const t of added) {
    const name = shortName(t.test)
    const self =
      (SELF_COMPARE.has(name) && ["compare_model", "to", "compare_to"].some((a) => refsEntity(arg(t, a), t.entity))) ||
      (name === "relationships" && refsEntity(arg(t, "to"), t.entity) && String(arg(t, "field") ?? "").toLowerCase() === (t.column ?? "").toLowerCase())
    if (self)
      out.push(
        finding(file, t.entity, "test-compares-model-with-itself", "warning", `${t.entity}: \`${t.test}\` compares the model with itself`,
          `This test checks \`${t.entity}\`${t.column ? `.\`${t.column}\`` : ""} against \`ref('${t.entity}')\`, so it passes by construction. ` +
            "Point it at the independent source of truth it is meant to reconcile against.", `:${key(t)}`),
      )
  }

  const project = parse(input.projectYml)
  if (project && added.length) {
    const inherited = inheritedThresholds(project, segmentsOf(file.path, input.layout))
    const own = (t: TestRef) => {
      const c = t.args?.config ?? {}
      return [c.severity, c.error_if, c.warn_if, t.args?.severity, t.args?.error_if].some((v) => v !== undefined)
    }
    const loose = added.filter((t) => !own(t))
    const where = inherited.path.length ? ` (\`data_tests:\` → ${inherited.path.map((p) => `\`${p}\``).join(" → ")})` : ""
    if (loose.length && inherited.severity === "warn")
      out.push(
        finding(file, undefined, "test-inherits-warn", "suggestion", `${loose.length} new test(s) in ${file.path} inherit \`severity: warn\``,
          `They inherit \`severity: warn\` from \`dbt_project.yml\`${where}, so failures are reported but never fail \`dbt build\`. ` +
            "If a test should gate the build, set `config: {severity: error}` on it."),
      )
    else if (loose.length && inherited.error_if && inherited.error_if !== "!= 0")
      out.push(
        finding(file, undefined, "test-inherits-threshold", "suggestion", `${loose.length} new test(s) in ${file.path} inherit \`error_if: ${inherited.error_if}\``,
          `They fail only when \`${inherited.error_if}\` rows fail, a threshold inherited from \`dbt_project.yml\`${where}. ` +
            "Set `config: {error_if: '!= 0'}` on tests that must catch any bad row."),
      )
  }
  return out
}

/** A `dbt_project.yml` change that loosens test thresholds for a whole path. */
export function detectThresholdLoosening(file: ChangedFile, oldContent?: string, newContent?: string): Finding[] {
  const oldDoc = parse(oldContent)
  const newDoc = parse(newContent)
  if (!oldDoc || !newDoc) return []
  const flat = (doc: any) => {
    const out = new Map<string, ReturnType<typeof thresholds>>()
    const visit = (node: any, path: string[]) => {
      if (!node || typeof node !== "object") return
      out.set(path.join(" → ") || "(all tests)", thresholds(node))
      for (const [k, v] of Object.entries(node)) if (!k.startsWith("+") && v && typeof v === "object") visit(v, [...path, k])
    }
    visit(doc?.data_tests ?? doc?.tests, [])
    return out
  }
  const before = flat(oldDoc)
  const out: Finding[] = []
  for (const [path, t] of flat(newDoc)) {
    const prev = before.get(path) ?? {}
    const toWarn = t.severity === "warn" && prev.severity !== "warn"
    const newThreshold = t.error_if && t.error_if !== "!= 0" && t.error_if !== prev.error_if
    if (!toWarn && !newThreshold) continue
    out.push(
      finding(file, undefined, "test-thresholds-loosened", "warning", `test thresholds loosened for \`${path}\``,
        (toWarn ? "`severity: warn` now applies" : `\`error_if: ${t.error_if}\` now applies`) +
          ` to every data test under \`${path}\` in \`dbt_project.yml\`, so those tests stop failing the build. ` +
          "Prefer setting it on the specific tests that need it.", `:${path}`),
    )
  }
  return out
}
