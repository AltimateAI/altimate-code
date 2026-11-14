// altimate_change - review rules for dbt files outside the SELECT: packages.yml,
// dbt_project.yml, Jinja structure in macros/models, and model config combinations.
import path from "path"
import YAML from "yaml"
import { type Finding, type ReviewCategory, type Severity, makeFinding } from "./finding"
import type { ChangedFile } from "./diff-filter"
import { incrementalFilter, inlineConfig } from "./incremental-semantics"
import { parenBody, topLevel } from "./rule-catalog"

const nameOf = (p: string) => path.basename(p).replace(/\.(sql|py|ya?ml|csv)$/i, "")

function finding(
  file: ChangedFile,
  rule: string,
  severity: Severity,
  category: ReviewCategory,
  title: string,
  body: string,
): Finding {
  const model = nameOf(file.path)
  return makeFinding({
    severity,
    category,
    title: `${model}: ${title}`,
    body,
    file: file.path,
    model,
    confidence: "high",
    evidence: { tool: "dbt-project-rules", result: { rule } },
    ruleKey: `${category}:${rule}`,
  })
}

const addedLines = (diff: string | undefined) =>
  (diff ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))

function parseYaml(text: string | undefined): any {
  if (!text) return undefined
  try {
    return YAML.parse(text)
  } catch {
    return undefined
  }
}

// ── packages.yml ────────────────────────────────────────────────────────────

/** A release tag (`v1.2.3`, `1.2.3`, `0.9.0-b1`) or a full commit sha: both reproducible. */
const PINNED_REVISION = /^(v?\d+(\.\d+){1,2}([-.+][\w.]+)?|[0-9a-f]{40})$/i

/** packages.yml / dependencies.yml entries that track a git branch instead of a release. */
export function packagesFindings(file: ChangedFile, newContent: string | undefined): Finding[] {
  if (!/(^|\/)(packages|dependencies)\.ya?ml$/i.test(file.path) || file.status === "deleted") return []
  const doc = parseYaml(newContent)
  const pkgs: any[] = Array.isArray(doc?.packages) ? doc.packages : []
  const added = addedLines(file.diff).join("\n")
  const branchPinned = pkgs.filter(
    (p) => p && typeof p.git === "string" && (p.revision === undefined || !PINNED_REVISION.test(String(p.revision))),
  )
  // Only entries this PR touched: a long-standing branch pin is not this change's decision.
  const touched = branchPinned.filter((p) => added.includes(p.git) || (p.revision !== undefined && added.includes(String(p.revision))))
  if (!touched.length) return []
  const list = touched.map((p) => `\`${p.git}\` @ \`${p.revision ?? "default branch"}\``).join(", ")
  return [
    finding(
      file,
      "package-git-branch",
      "warning",
      "materialization",
      "package installed from a git branch",
      `${list} tracks a branch, so \`dbt deps\` installs whatever the branch holds on the day it runs. Pin a release (\`package:\` + \`version:\` range) or a tag/commit sha before merging.`,
    ),
  ]
}

// ── dbt_project.yml ─────────────────────────────────────────────────────────

function semverParts(v: unknown): number[] | undefined {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ""))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined
}

function lowerVersion(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** Every `grants:` mapping anywhere under the given node, with its path. */
function grantsBlocks(node: any, at: string[] = [], out: { at: string; grants: Record<string, unknown> }[] = []) {
  if (!node || typeof node !== "object") return out
  for (const [k, v] of Object.entries(node)) {
    if ((k === "grants" || k === "+grants") && v && typeof v === "object" && !Array.isArray(v)) out.push({ at: [...at, k].join("."), grants: v as Record<string, unknown> })
    else grantsBlocks(v, [...at, k], out)
  }
  return out
}

export function dbtProjectFindings(file: ChangedFile, oldContent: string | undefined, newContent: string | undefined): Finding[] {
  if (!/(^|\/)dbt_project\.ya?ml$/i.test(file.path) || file.status === "deleted") return []
  const now = parseYaml(newContent)
  if (!now) return []
  const before = parseYaml(oldContent)
  const out: Finding[] = []

  const vNew = semverParts(now.version)
  const vOld = semverParts(before?.version)
  if (vNew && vOld && lowerVersion(vNew, vOld))
    out.push(
      finding(
        file,
        "project-version-lowered",
        "warning",
        "materialization",
        "project version goes down",
        `\`version\` changes from \`${before.version}\` to \`${now.version}\`. A release must move the version up, or consumers resolving a version range get the older release.`,
      ),
    )

  const oldDup = new Set(grantsBlocks(before).map((g) => g.at))
  for (const { at, grants } of grantsBlocks(now)) {
    for (const [priv, who] of Object.entries(grants)) {
      if (!Array.isArray(who)) continue
      const seen = new Set<string>()
      const dups = who.map(String).filter((r) => (seen.has(r.toLowerCase()) ? true : (seen.add(r.toLowerCase()), false)))
      if (dups.length && !(oldDup.has(at) && sameDup(before, at, priv, dups)))
        out.push(
          finding(
            file,
            "grants-duplicate",
            "suggestion",
            "sql_quality",
            `duplicate grantee under \`${at}.${priv}\``,
            `${[...new Set(dups)].map((d) => `\`${d}\``).join(", ")} is listed more than once. Usually a copy-paste where another role was meant; check the list is complete.`,
          ),
        )
    }
  }

  const disabledNow = (newContent?.match(/^\s*\+?enabled\s*:\s*false\b/gim) ?? []).length
  const disabledBefore = (oldContent?.match(/^\s*\+?enabled\s*:\s*false\b/gim) ?? []).length
  if (disabledNow > disabledBefore && addedLines(file.diff).some((l) => /^\s*\+?enabled\s*:\s*false\b/i.test(l)))
    out.push(
      finding(
        file,
        "models-disabled",
        "suggestion",
        "lineage_breakage",
        "resources disabled in dbt_project.yml",
        "This change adds `enabled: false`. Disabled models drop out of the DAG: anything that refs them fails to compile and their tables stop refreshing. Say in the PR why, and whether downstream models are disabled too.",
      ),
    )
  return out
}

function sameDup(before: any, at: string, priv: string, dups: string[]): boolean {
  const blk = grantsBlocks(before).find((g) => g.at === at)
  const who = blk?.grants[priv]
  if (!Array.isArray(who)) return false
  const lower = who.map((x) => String(x).toLowerCase())
  return dups.every((d) => lower.filter((x) => x === d.toLowerCase()).length > 1)
}

// ── Jinja structure (macros, models, tests, snapshots) ──────────────────────

const BLOCK_OPEN = ["if", "for", "macro", "call", "filter", "raw", "materialization", "test", "snapshot", "docs"]

/** Open/close balance of Jinja blocks; returns a message for the first problem, or undefined. */
export function jinjaBalance(sql: string): string | undefined {
  const text = sql.replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, " ").replace(/\{#[\s\S]*?#\}/g, " ")
  const stack: string[] = []
  for (const m of text.matchAll(/\{%-?\s*(\w+)([\s\S]*?)-?%\}/g)) {
    const tag = m[1].toLowerCase()
    const rest = m[2]
    if (tag === "set") {
      // `{% set x %}…{% endset %}` is a block; `{% set x = … %}` is not.
      if (!/=/.test(rest)) stack.push("set")
      continue
    }
    if (BLOCK_OPEN.includes(tag)) {
      if (tag === "macro" && !/^\s*[\w.]+\s*\(/.test(rest)) return `\`{% macro${rest.trimEnd()} %}\` has no parameter list; Jinja requires \`()\` even when empty`
      stack.push(tag)
      continue
    }
    if (tag.startsWith("end")) {
      const want = tag.slice(3)
      if (stack[stack.length - 1] === want) stack.pop()
      else if (!stack.includes(want)) return `\`{% ${tag} %}\` closes no open \`{% ${want} %}\``
      else return `\`{% ${tag} %}\` closes \`{% ${want} %}\` while \`{% ${stack[stack.length - 1]} %}\` is still open`
    }
  }
  if (stack.length) return `\`{% ${stack[stack.length - 1]} %}\` is never closed (missing \`{% end${stack[stack.length - 1]} %}\`)`
  return undefined
}

const macroSignatures = (sql: string | undefined) => {
  const out = new Map<string, string[]>()
  for (const m of (sql ?? "").matchAll(/\{%-?\s*macro\s+([\w.]+)\s*\(([^)]*)\)/g))
    out.set(m[1], m[2].split(",").map((p) => p.split("=")[0].trim()).filter(Boolean))
  return out
}

/** The comment text on a line (`-- …`, `/* … *\/`, `{# … #}`), or "". */
const commentOf = (l: string) => /--(.*)$|\/\*(.*?)(\*\/|$)|\{#(.*?)(#\}|$)/.exec(l)?.slice(1).filter(Boolean).join(" ") ?? ""
const TEMP_MARKER =
  /\b(temp(orary)?\b.{0,40}\b(ci|test|validation|sample|debug|hack)|revert\b.{0,30}\b(to|before|after)\b|do\s+not\s+merge|remove\s+before\s+(merge|release)|ci\s+test\b|for\s+testing\s+only)/i

const varNames = (sql: string | undefined) => new Set([...(sql ?? "").matchAll(/\bvar\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))

export function jinjaFindings(file: ChangedFile, oldContent: string | undefined, newContent: string | undefined): Finding[] {
  if (!newContent || file.status === "deleted" || !/\.sql$/i.test(file.path)) return []
  const out: Finding[] = []

  const problem = jinjaBalance(newContent)
  if (problem && !(oldContent && jinjaBalance(oldContent)))
    out.push(
      finding(
        file,
        "jinja-unbalanced",
        "warning",
        "sql_correctness",
        "Jinja block structure is broken",
        `${problem}. dbt fails to compile this file and every model that uses it.`,
      ),
    )

  // A parameter inserted before existing ones rebinds every positional call.
  if (oldContent) {
    const before = macroSignatures(oldContent)
    for (const [name, params] of macroSignatures(newContent)) {
      const old = before.get(name)
      if (!old || old.length === 0) continue
      const kept = old.filter((p) => params.includes(p))
      const shifted = kept.filter((p) => params.indexOf(p) !== old.indexOf(p))
      if (shifted.length)
        out.push(
          finding(
            file,
            "macro-param-shifted",
            "warning",
            "sql_correctness",
            `\`${name}\` parameters moved position`,
            `${shifted.map((p) => `\`${p}\``).join(", ")} ${shifted.length === 1 ? "is" : "are"} no longer at the same position in \`${name}(${params.join(", ")})\`. Callers that pass arguments positionally now bind them to different parameters. Add new parameters at the end, or check every caller uses keywords.`,
          ),
        )
    }

    // A var() key renamed with no fallback: projects that set the old key lose their override silently.
    const oldVars = varNames(oldContent)
    const newVars = varNames(newContent)
    const gone = [...oldVars].filter((v) => !newVars.has(v))
    const fresh = [...newVars].filter((v) => !oldVars.has(v))
    if (gone.length && fresh.length)
      out.push(
        finding(
          file,
          "var-renamed-no-fallback",
          "warning",
          "semantic_change",
          "var() key renamed without a fallback",
          `This file no longer reads ${gone.map((v) => `\`${v}\``).join(", ")} and now reads ${fresh.map((v) => `\`${v}\``).join(", ")}. Projects that set the old key in \`dbt_project.yml\` keep running with the default and no error. Read the new key with the old one as its default, e.g. \`var('${fresh[0]}', var('${gone[0]}', <default>))\`.`,
        ),
      )
  }

  // Code marked as temporary in its own comment: a CI sample, a test date, a "revert before merge".
  const marker = addedLines(file.diff).find((l) => TEMP_MARKER.test(commentOf(l)))
  if (marker)
    out.push(
      finding(
        file,
        "temporary-code-marker",
        "warning",
        "sql_correctness",
        "code marked temporary is part of the change",
        `\`${marker.trim().slice(0, 160)}\` says it is temporary. If this merges, the temporary filter, date or sample ships to production. Revert it, or drop the comment if it is meant to stay.`,
      ),
    )

  if (addedLines(file.diff).some((l) => /modules\.datetime\.datetime\.utcnow\s*\(/.test(l)))
    out.push(
      finding(
        file,
        "jinja-utcnow",
        "suggestion",
        "idempotency",
        "`datetime.utcnow()` returns a naive timestamp",
        "`utcnow()` is deprecated since Python 3.12 and returns a timestamp with no timezone, which compares wrongly against aware ones. Use `modules.datetime.datetime.now(modules.datetime.timezone.utc)`.",
      ),
    )
  return out
}

// ── model config combinations ───────────────────────────────────────────────

const unquote = (v: string | undefined) => (v ?? "").trim().replace(/^['"]|['"]$/g, "")
const literals = (v: string | undefined) => [...(v ?? "").matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase())

/** Partition column names from a `partition_by` config value (BigQuery dict, list, or string). */
function partitionColumns(v: string | undefined): string[] {
  if (!v) return []
  const field = /['"]field['"]\s*:\s*['"]([^'"]+)['"]/i.exec(v)
  if (field) return [field[1].toLowerCase()]
  return literals(v)
}

/** Literals a config value can take: its own, or those of the `{% set name = … %}` it names. */
function valueLiterals(v: string | undefined, sql: string): string[] {
  const own = literals(v)
  if (own.length || !v || !/^\s*\w+\s*$/.test(v)) return own
  const set = new RegExp(`\\{%-?\\s*set\\s+${v.trim()}\\s*=([^%]*)%\\}`).exec(sql)
  return set ? literals(set[1]) : []
}

export function modelConfigFindings(
  file: ChangedFile,
  newSql: string | undefined,
  dialect: string,
  /** The manifest's config for the model: fills what the file leaves to project defaults. */
  manifestConfig?: Record<string, unknown>,
): Finding[] {
  if (!newSql || file.status === "deleted") return []
  const cfg = inlineConfig(newSql)
  const touched = addedLines(file.diff).join("\n")
  // Only when the config or the incremental filter is part of this change.
  if (!/config\s*\(|unique_key|partition_by|batch_size|materialized|incremental|is_incremental/i.test(touched)) return []
  const out: Finding[] = []
  const materialized = (unquote(cfg.materialized) || String(manifestConfig?.materialized ?? "")).toLowerCase()
  const strategy = unquote(cfg.incremental_strategy).toLowerCase()

  if (cfg.unique_key && (materialized === "table" || materialized === "view"))
    out.push(
      finding(
        file,
        "unique-key-not-incremental",
        "suggestion",
        "materialization",
        `\`unique_key\` has no effect on a ${materialized}`,
        `\`unique_key\` only drives incremental merges; on a \`${materialized}\` it neither deduplicates nor checks anything. Add a \`unique\` / \`unique_combination_of_columns\` test to enforce it.`,
      ),
    )

  // dbt-bigquery requires microbatch `batch_size` to equal the partition granularity.
  // A `partition_by` dict with `granularity` is BigQuery's syntax, so it identifies the adapter too.
  if (strategy === "microbatch" && (/bigquery/i.test(dialect) || /['"]granularity['"]\s*:/.test(cfg.partition_by ?? ""))) {
    const sizes = valueLiterals(cfg.batch_size, newSql).filter((s) => ["hour", "day", "month", "year"].includes(s))
    const gran = /['"]granularity['"]\s*:\s*['"](\w+)['"]/i.exec(cfg.partition_by ?? "")?.[1]?.toLowerCase() ?? (cfg.partition_by ? "day" : undefined)
    const off = gran ? sizes.filter((s) => s !== gran) : []
    if (off.length)
      out.push(
        finding(
          file,
          "microbatch-granularity-mismatch",
          "warning",
          "materialization",
          "microbatch `batch_size` differs from the partition granularity",
          `\`batch_size\` can be ${off.map((s) => `\`${s}\``).join(", ")} but \`partition_by\` granularity is \`${gran}\`. dbt-bigquery rejects a microbatch model whose batch size and partition granularity differ, so those runs fail before executing.`,
        ),
      )
  }

  if (materialized === "incremental") {
    const parts = partitionColumns(cfg.partition_by)
    const uk = literals(cfg.unique_key).length ? literals(cfg.unique_key) : cfg.unique_key ? [unquote(cfg.unique_key).toLowerCase()] : []
    if (parts.length && uk.length && strategy === "merge" && !/bigquery/i.test(dialect)) {
      const missing = parts.filter((p) => !uk.includes(p))
      if (missing.length)
        out.push(
          finding(
            file,
            "partition-not-in-merge-key",
            "suggestion",
            "warehouse_cost",
            "partition column is not in the merge `unique_key`",
            `The table is partitioned by ${missing.map((p) => `\`${p}\``).join(", ")}, which \`unique_key\` [${uk.join(", ")}] doesn't include, so the merge can't prune target partitions and scans the whole table. Add the partition column to \`unique_key\` (or \`incremental_predicates\`).`,
          ),
        )
    }
    // The incremental filter should constrain the partition column, or each run scans every partition.
    const filter = incrementalFilter(newSql)
    if (parts.length && filter && !parts.some((p) => new RegExp(`\\b${p}\\b`, "i").test(filter)))
      out.push(
        finding(
          file,
          "incremental-filter-not-partition",
          "suggestion",
          "warehouse_cost",
          "incremental filter doesn't use the partition column",
          `The \`is_incremental()\` filter never constrains ${parts.map((p) => `\`${p}\``).join(", ")}, the partition column, so each run reads every partition of the source/target. Filter on the partition column (alone or alongside the timestamp).`,
        ),
      )
    // Filtering on a creation timestamp misses updates to rows created earlier.
    // Rows are expected to change when the model carries an update timestamp or merges on a key.
    const rowsChange = /\b\w*(updated|modified|changed)(_at|_on|_date|_ts|_time)\b/i.test(newSql) || (uk.length > 0 && strategy !== "append")
    if (filter && /\b\w*(created|inserted)(_at|_on|_date|_ts|_time)\b/i.test(filter) && !/\b\w*(updated|modified|changed)\w*\b/i.test(filter) && rowsChange)
      out.push(
        finding(
          file,
          "incremental-filter-created-only",
          "suggestion",
          "materialization",
          "incremental filter reads new rows only, not updated ones",
          "The `is_incremental()` filter keys on a creation timestamp while the model also carries an update timestamp. Rows created before the last run and changed since are never picked up again. Filter on the update timestamp, or explain why rows never change.",
        ),
      )
  }
  return out
}

// ── ref() targets ───────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

/** Single-argument `ref('x')` on added lines whose target no resource carries. */
export function missingRefFindings(file: ChangedFile, names: Set<string>): Finding[] {
  const refs = new Set<string>()
  for (const l of addedLines(file.diff))
    for (const m of l.matchAll(/\bref\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*v(?:ersion)?\s*=\s*[^)]*)?\)/g)) refs.add(m[1])
  const missing = [...refs].filter((r) => !names.has(r.toLowerCase()) && !names.has(r.toLowerCase().replace(/_v\d+$/, "")))
  return missing.map((r) => {
    const near = [...names].filter((n) => Math.abs(n.length - r.length) <= 2 && editDistance(n, r.toLowerCase()) <= 2)
    return finding(
      file,
      "ref-target-missing",
      "warning",
      "sql_correctness",
      `\`ref('${r}')\` points at no model`,
      `No model, seed or snapshot named \`${r}\` exists in this project or its installed packages, so dbt fails to parse the project.${near.length ? ` Did you mean ${near.slice(0, 3).map((n) => `\`${n}\``).join(", ")}?` : " Add the model in this PR or fix the name."}`,
    )
  })
}

// ── join keys vs declared uniqueness ────────────────────────────────────────

export interface JoinTarget {
  /** The model the joined relation reads (directly, or through a pass-through CTE). */
  model: string
  /** Columns of the joined side compared with `=` in the ON clause. */
  keys: string[]
  /** The JOIN text, for the finding. */
  join: string
}

const REF = /\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/

/** CTEs that pass one ref through unchanged in grain (no GROUP BY / DISTINCT / JOIN / QUALIFY / UNION). */
function passThroughCtes(sql: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of sql.matchAll(/(?:\bwith\b|,)\s*(\w+)\s+as\s*\(/gi)) {
    const body = parenBody(sql, m.index! + m[0].length - 1)
    const top = topLevel(body)
    const ref = REF.exec(body)
    // `{{ ref(...) }}` sits in parens that topLevel blanks, so test grain-changing keywords on the top level.
    if (ref && /\bfrom\b/i.test(top) && !/\b(group\s+by|distinct|join|qualify|union|limit)\b/i.test(top)) out.set(m[1].toLowerCase(), ref[1])
  }
  return out
}

const ON_STOP = /^(?:join|left|right|inner|full|cross|where|group|order|qualify|having|union|limit|window|select|\{%)\b/i

/** Joins whose ON clause or JOIN line is on an added line, with the joined model and its key columns. */
export function joinTargets(sql: string, added: string[]): JoinTarget[] {
  const ctes = passThroughCtes(sql)
  const changed = added.map((l) => l.replace(/--.*$/, "").trim()).filter((l) => /\w{2}/.test(l))
  const out: JoinTarget[] = []
  const re = /\bjoin\s+(\{\{\s*ref\(\s*['"][^'"]+['"]\s*\)\s*\}\}|\w+)\s*(?:as\s+)?(\w+)?\s+on\b/gi
  for (const m of sql.matchAll(re)) {
    const rel = m[1]
    const alias = (m[2] && !/^on$/i.test(m[2]) ? m[2] : (REF.exec(rel)?.[1] ?? rel)).toLowerCase()
    const model = REF.exec(rel)?.[1] ?? ctes.get(rel.toLowerCase())
    if (!model) continue
    // ON clause: up to the next clause keyword at paren depth 0.
    let i = m.index! + m[0].length
    let depth = 0
    const start = i
    for (; i < sql.length; i++) {
      const c = sql[i]
      if (c === "(") depth++
      else if (c === ")") {
        if (depth === 0) break
        depth--
      } else if (depth === 0 && /\s/.test(sql[i - 1] ?? " ") && ON_STOP.test(sql.slice(i, i + 10))) break
    }
    const on = sql.slice(start, i)
    const text = sql.slice(sql.lastIndexOf("\n", m.index!) + 1, i)
    if (!changed.some((l) => text.includes(l))) continue
    const keys = new Set<string>()
    for (const e of on.matchAll(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/g)) {
      if (e[1].toLowerCase() === alias) keys.add(e[2].toLowerCase())
      if (e[3].toLowerCase() === alias) keys.add(e[4].toLowerCase())
    }
    if (keys.size) out.push({ model, keys: [...keys], join: text.replace(/\s+/g, " ").trim().slice(0, 160) })
  }
  return out
}

// ── tests on columns the SQL sets to NULL ───────────────────────────────────

/** Columns a model projects as a bare NULL (`null as c`, `cast(null as t) as c`, `null::t as c`). */
export function literalNullColumns(sql: string): Set<string> {
  const s = sql.replace(/--[^\n]*/g, " ").replace(/\{#[\s\S]*?#\}/g, " ")
  const out = new Set<string>()
  for (const m of s.matchAll(/(?:^|[,(\s])(?:null(?:\s*::\s*\w+(?:\([^)]*\))?)?|cast\s*\(\s*null\s+as\s+[^)]*\))\s+as\s+["`]?(\w+)/gi)) out.add(m[1].toLowerCase())
  return out
}

const testNames = (tests: unknown): string[] =>
  Array.isArray(tests) ? tests.map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? Object.keys(t)[0] : "")).filter(Boolean) : []

/** not_null / relationships tests, added in this diff, on a column the model always sets to NULL. */
export function testsOnNullColumns(file: ChangedFile, ymlContent: string | undefined, sqlByModel: Map<string, string>): Finding[] {
  const doc = parseYaml(ymlContent)
  if (!Array.isArray(doc?.models)) return []
  const added = addedLines(file.diff).join("\n")
  const out: Finding[] = []
  for (const m of doc.models) {
    const sql = m?.name && sqlByModel.get(String(m.name).toLowerCase())
    if (!sql || !Array.isArray(m.columns)) continue
    const nulls = literalNullColumns(sql)
    for (const c of m.columns) {
      const col = String(c?.name ?? "").toLowerCase()
      if (!nulls.has(col)) continue
      const failing = [...testNames(c.data_tests), ...testNames(c.tests)].filter((t) => /(^|\.)(not_null|relationships)$/.test(t))
      if (!failing.length || !new RegExp(`\\b${col}\\b|not_null|relationships`, "i").test(added)) continue
      out.push(
        finding(
          file,
          "test-on-null-column",
          "warning",
          "test_coverage",
          `\`${m.name}.${c.name}\` is tested but the model sets it to NULL`,
          `\`${m.name}\` selects \`${c.name}\` as a literal NULL, so its ${failing.map((t) => `\`${t}\``).join(" / ")} test fails on every row. Drop the test until the column is populated, or populate it.`,
        ),
      )
    }
  }
  return out
}
