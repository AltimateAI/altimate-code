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

/**
 * Failing rows an `error_if` condition tolerates: `!= 0` / `> 0` → 0, `> 10` → 10,
 * `>= 10` → 9. Undefined when the condition isn't a simple bound.
 */
function allowedFailures(cond: string | undefined): number | undefined {
  const m = cond ? /^(!=|<>|>=|>)\s*(\d+)$/.exec(cond.trim()) : null
  if (!m) return undefined
  const n = Number(m[2])
  if (m[1] === ">=") return Math.max(0, n - 1)
  if (m[1] === ">") return n
  return n === 0 ? 0 : undefined
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

/** Folders of a yml below its resource path (e.g. `models/marts/x.yml` → `["marts"]`, `seeds/x.yml` → `[]`). */
function segmentsOf(file: string, layout?: DbtProjectLayout): string[] {
  const root = layout?.root ? layout.root.replace(/\/$/, "") + "/" : ""
  const rel = root && file.startsWith(root) ? file.slice(root.length) : file
  const parts = rel.split("/").slice(0, -1)
  const resourceDirs = layout ? Object.values(layout.dirs).flat() : ["models", "seeds", "snapshots", "tests"]
  return resourceDirs.includes(parts[0]) ? parts.slice(1) : parts
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
    // Different expressions on the same model are a valid invariant (e.g. sum of
    // line items equals the order total); only the same expression is circular.
    const sameExpression =
      name !== "expect_table_aggregation_to_equal_other_table" ||
      String(arg(t, "compare_expression") ?? arg(t, "expression") ?? "").replace(/\s+/g, "").toLowerCase() ===
        String(arg(t, "expression") ?? "").replace(/\s+/g, "").toLowerCase()
    // `cardinality_equality` compares this column with `field` on the other
    // model; against itself it is circular only when the field is the same column.
    const sameField =
      name !== "cardinality_equality" || String(arg(t, "field") ?? "").toLowerCase() === (t.column ?? "").toLowerCase()
    const self =
      (SELF_COMPARE.has(name) && sameExpression && sameField && ["compare_model", "to", "compare_to"].some((a) => refsEntity(arg(t, a), t.entity))) ||
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
    // dbt resolves `severity` and `error_if` separately: a local `warn_if` or
    // `error_if` still leaves `severity` inherited, and vice versa.
    const local = (t: TestRef, k: "severity" | "error_if") => t.args?.config?.[k] ?? t.args?.[k]
    const inheritingWarn = added.filter((t) => local(t, "severity") === undefined)
    const inheritingThreshold = added.filter(
      (t) => local(t, "error_if") === undefined && String(local(t, "severity") ?? inherited.severity ?? "error").toLowerCase() !== "warn",
    )
    const where = inherited.path.length ? ` (\`data_tests:\` → ${inherited.path.map((p) => `\`${p}\``).join(" → ")})` : ""
    if (inheritingWarn.length && inherited.severity === "warn")
      out.push(
        finding(file, undefined, "test-inherits-warn", "suggestion", `${inheritingWarn.length} new test(s) in ${file.path} inherit \`severity: warn\``,
          `They inherit \`severity: warn\` from \`dbt_project.yml\`${where}, so failures are reported but never fail \`dbt build\`. ` +
            "If a test should gate the build, set `config: {severity: error}` on it."),
      )
    else if (inheritingThreshold.length && inherited.error_if && allowedFailures(inherited.error_if) !== 0)
      out.push(
        finding(file, undefined, "test-inherits-threshold", "suggestion", `${inheritingThreshold.length} new test(s) in ${file.path} inherit \`error_if: ${inherited.error_if}\``,
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
  // Every config path in either version: a deleted override loosens its subtree too.
  const paths = new Map<string, string[]>()
  const visit = (node: any, path: string[]) => {
    if (!node || typeof node !== "object") return
    paths.set(path.join("\u0000"), path)
    for (const [k, v] of Object.entries(node)) if (!k.startsWith("+") && v && typeof v === "object") visit(v, [...path, k])
  }
  visit(oldDoc?.data_tests ?? oldDoc?.tests, [])
  visit(newDoc?.data_tests ?? newDoc?.tests, [])
  // Effective values at a path, walking the tree from the top (no project-name prepend:
  // the path already names it when the config does).
  const effective = (doc: any, path: string[]) => {
    const eff: { severity: string; error_if?: string } = { severity: "error" }
    let node = doc?.data_tests ?? doc?.tests
    for (let i = 0; i <= path.length && node && typeof node === "object"; i++) {
      const t = thresholds(node)
      if (t.severity) eff.severity = t.severity
      if (t.error_if) eff.error_if = t.error_if
      node = node[path[i]]
    }
    return eff
  }
  const loosened = (path: string[]) => {
    const prev = effective(oldDoc, path)
    const next = effective(newDoc, path)
    const toWarn = next.severity === "warn" && prev.severity !== "warn"
    // Only a bound that tolerates more failing rows loosens; a changed condition
    // that isn't a simple bound is still reported.
    const allowed = allowedFailures(next.error_if)
    const looserThreshold =
      next.severity !== "warn" &&
      prev.severity !== "warn" &&
      next.error_if !== prev.error_if &&
      !!next.error_if &&
      (allowed === undefined || allowed > (allowedFailures(prev.error_if) ?? 0))
    return toWarn ? { why: "`severity: warn` now applies" } : looserThreshold ? { why: `\`error_if: ${next.error_if}\` now applies` } : undefined
  }
  const out: Finding[] = []
  for (const path of paths.values()) {
    const hit = loosened(path)
    // Report only the topmost loosened path, not each folder below it.
    if (!hit || (path.length && loosened(path.slice(0, -1)))) continue
    const label = path.join(" → ") || "(all tests)"
    out.push(
      finding(file, undefined, "test-thresholds-loosened", "warning", `test thresholds loosened for \`${label}\``,
        `${hit.why} to every data test under \`${label}\` in \`dbt_project.yml\`, so those tests stop failing the build. ` +
          "Prefer setting it on the specific tests that need it.", `:${label}`),
    )
  }
  return out
}
