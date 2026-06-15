/**
 * Procedural trace annotator.
 *
 * Pure functions that classify spans and sessions without LLM judgment:
 *   - `annotateToolSpan(name, input, output)` — per-tool-span attributes
 *     (de.tool.*, de.dbt.*, de.sql.query_text from input fields)
 *   - `annotateSession(spans, metadata)` — session-level attributes
 *     (de.workflow.*, de.outcome.*, de.artifacts.*)
 *
 * Both return Record<string, unknown>. Both follow the rule:
 *   prefer absent attribute over wrong attribute.
 *   When the classifier isn't confident, return undefined for that key and
 *   the caller writes nothing.
 *
 * Tools never import this module. The tracer calls it from `logToolCall`
 * (per-span) and `endTrace` (session rollup). Tools opt into the metadata
 * channel separately by setting `de.*` keys on their returned metadata.
 */

import { DE } from "./de-attributes"
import type { TraceFile, TraceSpan } from "./tracing"

// ---------------------------------------------------------------------------
// Tool category lookup — deterministic taxonomy by tool name
// ---------------------------------------------------------------------------

type ToolClassification = {
  category: string
  subcategory?: string
  vendor?: string
}

const TOOL_TAXONOMY: Record<string, ToolClassification> = {
  // Built-in framework tools
  bash: { category: "exec", subcategory: "shell" },
  read: { category: "fs", subcategory: "read" },
  write: { category: "fs", subcategory: "write" },
  edit: { category: "fs", subcategory: "edit" },
  glob: { category: "fs", subcategory: "glob" },
  grep: { category: "fs", subcategory: "grep" },
  todowrite: { category: "planning", subcategory: "todo" },
  skill: { category: "planning", subcategory: "skill" },
  task: { category: "planning", subcategory: "subagent" },

  // Warehouse / SQL execution
  sql_execute: { category: "warehouse", subcategory: "execute" },
  sql_analyze: { category: "sql", subcategory: "analyze" },
  sql_optimize: { category: "sql", subcategory: "optimize" },
  sql_fix: { category: "sql", subcategory: "fix" },
  sql_format: { category: "sql", subcategory: "format" },
  sql_explain: { category: "sql", subcategory: "explain" },
  sql_translate: { category: "sql", subcategory: "translate" },
  sql_rewrite: { category: "sql", subcategory: "rewrite" },
  sql_diff: { category: "sql", subcategory: "diff" },
  sql_classify: { category: "sql", subcategory: "classify" },
  sql_autocomplete: { category: "sql", subcategory: "autocomplete" },

  // Schema
  schema_inspect: { category: "schema", subcategory: "inspect" },
  schema_search: { category: "schema", subcategory: "search" },
  schema_index: { category: "schema", subcategory: "index" },
  schema_diff: { category: "schema", subcategory: "diff" },
  schema_detect_pii: { category: "schema", subcategory: "pii" },
  schema_tags: { category: "schema", subcategory: "tags" },
  schema_cache_status: { category: "schema", subcategory: "cache" },

  // Warehouse management
  warehouse_list: { category: "warehouse", subcategory: "list" },
  warehouse_add: { category: "warehouse", subcategory: "add" },
  warehouse_remove: { category: "warehouse", subcategory: "remove" },
  warehouse_test: { category: "warehouse", subcategory: "test" },
  warehouse_discover: { category: "warehouse", subcategory: "discover" },

  // dbt
  dbt_profiles: { category: "dbt", subcategory: "profiles" },
  dbt_manifest: { category: "dbt", subcategory: "manifest" },
  dbt_lineage: { category: "dbt", subcategory: "lineage" },
  dbt_unit_test_gen: { category: "dbt", subcategory: "testgen" },

  // Lineage / impact
  lineage_check: { category: "lineage", subcategory: "check" },
  impact_analysis: { category: "lineage", subcategory: "impact" },

  // FinOps
  finops_query_history: { category: "finops", subcategory: "history" },
  finops_expensive_queries: { category: "finops", subcategory: "expensive" },
  finops_warehouse_advice: { category: "finops", subcategory: "advice" },
  finops_analyze_credits: { category: "finops", subcategory: "credits" },
  finops_unused_resources: { category: "finops", subcategory: "unused" },
  finops_role_access: { category: "finops", subcategory: "access" },

  // Data
  data_diff: { category: "quality", subcategory: "diff" },
  datamate: { category: "platform", subcategory: "datamate", vendor: "altimate" },
  project_scan: { category: "platform", subcategory: "scan", vendor: "altimate" },

  // Altimate-core wrappers
  altimate_core_check: { category: "sql", subcategory: "check", vendor: "altimate-core" },
  altimate_core_validate: { category: "sql", subcategory: "validate", vendor: "altimate-core" },
  altimate_core_classify_pii: { category: "schema", subcategory: "pii", vendor: "altimate-core" },
  altimate_core_column_lineage: { category: "lineage", subcategory: "column", vendor: "altimate-core" },
  altimate_core_track_lineage: { category: "lineage", subcategory: "track", vendor: "altimate-core" },
  altimate_core_compare: { category: "sql", subcategory: "compare", vendor: "altimate-core" },
  altimate_core_complete: { category: "sql", subcategory: "complete", vendor: "altimate-core" },
  altimate_core_correct: { category: "sql", subcategory: "correct", vendor: "altimate-core" },
  altimate_core_detect_join_candidates: { category: "lineage", subcategory: "join-candidates", vendor: "altimate-core" },
  altimate_core_equivalence: { category: "sql", subcategory: "equivalence", vendor: "altimate-core" },
  altimate_core_export_ddl: { category: "schema", subcategory: "export-ddl", vendor: "altimate-core" },
  altimate_core_extract_metadata: { category: "schema", subcategory: "extract", vendor: "altimate-core" },
  altimate_core_fingerprint: { category: "sql", subcategory: "fingerprint", vendor: "altimate-core" },
  altimate_core_fix: { category: "sql", subcategory: "fix", vendor: "altimate-core" },
  altimate_core_grade: { category: "sql", subcategory: "grade", vendor: "altimate-core" },
  altimate_core_import_ddl: { category: "schema", subcategory: "import-ddl", vendor: "altimate-core" },
  altimate_core_introspection_sql: { category: "schema", subcategory: "introspection", vendor: "altimate-core" },
  altimate_core_migration: { category: "schema", subcategory: "migration", vendor: "altimate-core" },
  altimate_core_optimize_context: { category: "sql", subcategory: "optimize", vendor: "altimate-core" },
  altimate_core_parse_dbt: { category: "dbt", subcategory: "parse", vendor: "altimate-core" },
  altimate_core_policy: { category: "schema", subcategory: "policy", vendor: "altimate-core" },
  altimate_core_prune_schema: { category: "schema", subcategory: "prune", vendor: "altimate-core" },
  altimate_core_query_pii: { category: "schema", subcategory: "query-pii", vendor: "altimate-core" },
  altimate_core_resolve_term: { category: "schema", subcategory: "resolve-term", vendor: "altimate-core" },
  altimate_core_rewrite: { category: "sql", subcategory: "rewrite", vendor: "altimate-core" },
  altimate_core_schema_diff: { category: "schema", subcategory: "diff", vendor: "altimate-core" },
  altimate_core_semantics: { category: "sql", subcategory: "semantics", vendor: "altimate-core" },
  altimate_core_testgen: { category: "dbt", subcategory: "testgen", vendor: "altimate-core" },
}

// ---------------------------------------------------------------------------
// dbt project layer detection from file path
// ---------------------------------------------------------------------------

const DBT_LAYER_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|\/)models\/staging\//i, "staging"],
  [/(?:^|\/)models\/(?:stg|stage)\//i, "staging"],
  [/(?:^|\/)models\/intermediate\//i, "intermediate"],
  [/(?:^|\/)models\/(?:int|inter)\//i, "intermediate"],
  [/(?:^|\/)models\/(?:dim|dims|dimensions)\//i, "dim"],
  [/(?:^|\/)models\/(?:fact|facts|fct)\//i, "fact"],
  [/(?:^|\/)models\/(?:agg|aggregates?|aggs)\//i, "agg"],
  [/(?:^|\/)models\/(?:mart|marts)\//i, "mart"],
  [/(?:^|\/)models\/(?:core|warehouse|curated)\//i, "mart"],
  [/(?:^|\/)seeds\//i, "seed"],
  [/(?:^|\/)macros\//i, "macro"],
  [/(?:^|\/)tests\//i, "test"],
  [/(?:^|\/)snapshots\//i, "snapshot"],
  [/(?:^|\/)sources?\.yml$/i, "source"],
  [/_sources?\.ya?ml$/i, "source"],
]

function dbtLayerFromPath(filePath: string | undefined): string | undefined {
  if (typeof filePath !== "string" || !filePath) return undefined
  // Normalize backslashes so windows-style paths match too, and ensure the
  // patterns match equally for absolute, relative, and bare paths.
  const norm = filePath.replace(/\\/g, "/")
  for (const [re, layer] of DBT_LAYER_PATTERNS) {
    if (re.test(norm)) return layer
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Bash command intent classification
// ---------------------------------------------------------------------------

type BashClassification = {
  intent: string
  invoked?: string
  dbtCommand?: string
}

function classifyBash(command: string | undefined): BashClassification | undefined {
  if (typeof command !== "string" || !command) return undefined

  // Strip leading "cd <dir> &&" so we classify the actual work.
  const stripped = command.replace(/^\s*cd\s+\S+\s*&&\s*/, "").trim()
  if (!stripped) return undefined

  // altimate-dbt CLI — MUST be checked before dbt below: `\b` is a word
  // boundary so `-` is non-word and `altimate-dbt build` would otherwise
  // match the dbt-verb regex and get misclassified as intent="dbt".
  if (/\baltimate-dbt\b/i.test(stripped)) {
    const verb = stripped.match(/\baltimate-dbt\s+([a-z][a-z0-9-]*)\b/i)
    return { intent: "altimate_dbt", invoked: "altimate-dbt", ...(verb && { dbtCommand: verb[1].toLowerCase() }) }
  }

  // dbt CLI: detect verb after `dbt`. Broad list of subcommands.
  const dbtVerbs = "build|run|test|seed|snapshot|compile|deps|run-operation|debug|parse|docs|clean|list|ls|source|init|show|retry|freshness"
  const dbtMatch = stripped.match(new RegExp(`\\bdbt\\s+(${dbtVerbs})\\b`, "i"))
  if (dbtMatch) {
    return { intent: "dbt", invoked: "dbt", dbtCommand: dbtMatch[1].toLowerCase() }
  }
  // dbt invoked but without a recognized verb (e.g. `dbt --version`, `dbt --help`)
  if (/\bdbt\b/.test(stripped)) {
    return { intent: "dbt", invoked: "dbt" }
  }

  // Python with inline SQL/DuckDB
  if (/\bpython3?\b/i.test(stripped) && /\b(duckdb|select\s|from\s|insert\s|create\s+table)\b/i.test(stripped)) {
    return { intent: "python_sql", invoked: "python3" }
  }

  // psql / clickhouse-client / sqlfluff
  if (/\bpsql\b/i.test(stripped)) return { intent: "sql", invoked: "psql" }
  if (/\bclickhouse-client\b/i.test(stripped)) return { intent: "sql", invoked: "clickhouse-client" }
  if (/\bsqlfluff\b/i.test(stripped)) return { intent: "sql_lint", invoked: "sqlfluff" }

  // Inline SQL (no driver, just a SELECT/INSERT/etc. somewhere)
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|WITH\s+\w+\s+AS)\b/i.test(stripped)) {
    return { intent: "sql" }
  }

  // Generic Python
  if (/\bpython3?\b/i.test(stripped)) return { intent: "python", invoked: "python3" }

  // VCS
  if (/^git\s/i.test(stripped)) return { intent: "vcs", invoked: "git" }

  // Install / package mgmt
  if (/^(npm|pnpm|yarn|bun|pip|pip3|brew|apt-get|cargo)\s/i.test(stripped)) {
    const tool = stripped.split(/\s+/)[0]
    return { intent: "install", invoked: tool }
  }

  // Filesystem
  if (/^(ls|find|cat|head|tail|cp|mv|rm|mkdir|touch|chmod|chown|du|df)\b/i.test(stripped)) {
    const tool = stripped.split(/\s+/)[0]
    return { intent: "fs", invoked: tool }
  }

  return { intent: "other" }
}

// ---------------------------------------------------------------------------
// SQL fragment extraction from input/output text
// ---------------------------------------------------------------------------

const SQL_TABLE_PATTERN = /\b(?:FROM|JOIN)\s+([A-Za-z_"`][A-Za-z0-9_."`\-]*)/gi

function extractInputTables(sql: string): string[] | undefined {
  if (typeof sql !== "string" || !sql) return undefined
  const seen = new Set<string>()
  for (const m of sql.matchAll(SQL_TABLE_PATTERN)) {
    // Strip quote chars; lowercase; cap individual size
    const raw = m[1].replace(/[`"]/g, "").trim()
    if (raw.length > 256) continue
    seen.add(raw.toLowerCase())
    if (seen.size > 50) break  // sanity cap
  }
  return seen.size > 0 ? [...seen] : undefined
}

// ---------------------------------------------------------------------------
// PUBLIC — per-tool-span classification
// ---------------------------------------------------------------------------

/**
 * Classify a single tool span from its name + input + output.
 * Returns attributes to merge into the span. Empty object = nothing to add.
 *
 * Pure function. Never throws (best-effort).
 */
export function annotateToolSpan(
  toolName: string,
  input: unknown,
  output: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    // Tool taxonomy (always)
    const tax = TOOL_TAXONOMY[toolName]
    if (tax) {
      out[DE.TOOL.CATEGORY] = tax.category
      if (tax.subcategory) out[DE.TOOL.SUBCATEGORY] = tax.subcategory
      if (tax.vendor) out[DE.TOOL.VENDOR] = tax.vendor
    } else {
      out[DE.TOOL.CATEGORY] = "generic"
    }

    const inp = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as Record<string, unknown>

    // Tool-specific input parsing
    if (toolName === "bash") {
      const bash = classifyBash(typeof inp.command === "string" ? inp.command : undefined)
      if (bash) {
        out[DE.TOOL.BASH_INTENT] = bash.intent
        if (bash.invoked) out[DE.TOOL.BASH_INVOKED] = bash.invoked
        if (bash.dbtCommand) out[DE.DBT.COMMAND] = bash.dbtCommand
      }
    } else if (toolName === "read" || toolName === "write" || toolName === "edit") {
      const layer = dbtLayerFromPath(typeof inp.filePath === "string" ? inp.filePath : undefined)
      if (layer) out[DE.DBT.LAYER] = layer
    } else if (toolName === "sql_execute" || toolName === "sql_analyze" || toolName === "sql_optimize" || toolName === "sql_fix" || toolName === "sql_explain" || toolName === "sql_translate" || toolName === "sql_rewrite" || toolName === "sql_format") {
      const q = typeof inp.query === "string" ? inp.query : (typeof inp.sql === "string" ? inp.sql : undefined)
      if (q) {
        // Cap the stored query text to keep span size bounded, but still extract
        // lineage from the full query so we don't lose table refs at the tail.
        out[DE.SQL.QUERY_TEXT] = q.slice(0, 8000)
        const tables = extractInputTables(q)
        if (tables) out[DE.SQL.LINEAGE_INPUT_TABLES] = tables
      }
    } else if (toolName === "skill") {
      const skill = typeof inp.name === "string" ? inp.name : (typeof inp.skill === "string" ? inp.skill : undefined)
      if (skill) out[DE.TOOL.SUBCATEGORY] = `skill.${skill}`
    }

    // SQL extracted from bash (overlay onto the bash classification)
    if (toolName === "bash" && typeof inp.command === "string") {
      const cmd = inp.command
      // Find a sql_execute-shaped SELECT/INSERT/CTE inside the bash command
      const sqlMatch = cmd.match(/(?:^|[\s'"`(])((?:WITH\s+\w[\s\S]{0,200}?AS\s*\(|SELECT|INSERT\s+INTO|UPDATE\s|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)[\s\S]+)/i)
      if (sqlMatch) {
        const sql = sqlMatch[1].slice(0, 8000)
        out[DE.SQL.QUERY_TEXT] = sql
        const tables = extractInputTables(sql)
        if (tables) out[DE.SQL.LINEAGE_INPUT_TABLES] = tables
      }
    }
  } catch {
    // best-effort — annotator must never break the tracer
  }
  return out
}

// ---------------------------------------------------------------------------
// PUBLIC — session-level rollup
// ---------------------------------------------------------------------------

/**
 * Workflow type heuristic. Returns { type, confidence } when confident,
 * undefined when not.
 *
 * Inputs: prompt text + tool span names + skill invocations.
 * Confidence: ratio of corroborating signals to total possible signals.
 */
function classifyWorkflow(
  prompt: string,
  toolNames: string[],
  skills: string[],
  spans: TraceSpan[],
): { type: string; confidence: number } | undefined {
  const p = prompt.toLowerCase()
  const hasTool = (n: string) => toolNames.includes(n)
  const hasSkill = (n: string) => skills.includes(n)

  // dbt-troubleshoot signals: skill, plus error/fix verbs
  if (hasSkill("dbt-troubleshoot")) return { type: "dbt_troubleshoot", confidence: 0.95 }
  if (hasSkill("debugging-dbt-errors")) return { type: "dbt_troubleshoot", confidence: 0.9 }

  // dbt-develop signals
  if (hasSkill("dbt-develop")) return { type: "dbt_develop", confidence: 0.95 }

  // Other dbt skills
  if (hasSkill("dbt-test") || hasSkill("testing-dbt-models")) return { type: "dbt_test", confidence: 0.9 }
  if (hasSkill("dbt-docs") || hasSkill("documenting-dbt-models")) return { type: "dbt_docs", confidence: 0.9 }
  if (hasSkill("dbt-pr-review")) return { type: "dbt_pr_review", confidence: 0.9 }
  if (hasSkill("dbt-schema-verify")) return { type: "dbt_schema_verify", confidence: 0.9 }

  // Tool-mix heuristics — count BASH SPANS BY INTENT, not all bash spans, so
  // `project_scan + wc -c` doesn't masquerade as a dbt session.
  const dbtBashCount = spans.filter((s) => {
    if (s.kind !== "tool" || s.name !== "bash") return false
    const attr = s.attributes
    return attr?.[DE.TOOL.BASH_INTENT] === "dbt" || attr?.[DE.TOOL.BASH_INTENT] === "altimate_dbt"
  }).length
  const sqlExecCount = toolNames.filter((n) => n === "sql_execute" || n === "sql_analyze").length
  const projectScan = hasTool("project_scan")

  if (projectScan && sqlExecCount === 0 && dbtBashCount === 0) {
    return { type: "warehouse_exploration", confidence: 0.6 }
  }
  if (dbtBashCount >= 3) {
    return { type: "dbt_develop", confidence: 0.6 }
  }
  if (sqlExecCount >= 3) {
    return { type: "sql_analysis", confidence: 0.7 }
  }

  // Prompt-driven fallbacks
  if (/\b(fix|debug|troubleshoot|broken|failing|error)\b/.test(p) && (toolNames.includes("read") || toolNames.includes("edit"))) {
    return { type: "dbt_troubleshoot", confidence: 0.5 }
  }
  if (/\b(create|add|build|model|refactor)\b/.test(p) && (toolNames.includes("write") || toolNames.includes("edit"))) {
    return { type: "dbt_develop", confidence: 0.5 }
  }

  return undefined
}

/**
 * Classify a session from its finished trace.
 * Returns attributes to attach to the session's root span.
 *
 * Pure function. Never throws (best-effort).
 */
export function annotateSession(trace: TraceFile): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    const toolSpans = trace.spans.filter((s) => s.kind === "tool")
    const toolNames = toolSpans.map((s) => s.name)
    const skillNames = toolSpans
      .filter((s) => s.name === "skill")
      .map((s) => {
        const inp = s.input as Record<string, unknown> | undefined
        return typeof inp?.name === "string" ? inp.name : (typeof inp?.skill === "string" ? inp.skill : "")
      })
      .filter(Boolean)

    // Outcome (deterministic — direct map from summary.status)
    const statusMap: Record<string, string> = {
      completed: "success",
      error: "failure",
      crashed: "interrupted",
      running: "interrupted",
    }
    const outcome = statusMap[trace.summary.status]
    if (outcome) out[DE.OUTCOME.CLASS] = outcome

    // Workflow (heuristic with confidence). Reads per-span `de.tool.bash_intent`
    // attribute (set by Layer 2 in logToolCall) to distinguish dbt-bash spans
    // from generic-bash spans.
    const wf = classifyWorkflow(trace.metadata.prompt ?? "", toolNames, skillNames, trace.spans)
    if (wf) {
      out[DE.WORKFLOW.TYPE] = wf.type
      out[DE.WORKFLOW.TYPE_CONFIDENCE] = wf.confidence
    }

    // Artifacts.touched (deterministic)
    const filesRead = new Set<string>()
    const filesEdited = new Set<string>()
    for (const span of toolSpans) {
      const inp = span.input as Record<string, unknown> | undefined
      const filePath = typeof inp?.filePath === "string" ? inp.filePath : undefined
      if (!filePath) continue
      if (span.name === "read") filesRead.add(filePath)
      else if (span.name === "write" || span.name === "edit") filesEdited.add(filePath)
    }
    if (filesRead.size > 0) out[DE.ARTIFACTS.FILES_READ] = [...filesRead].slice(0, 100)
    if (filesEdited.size > 0) out[DE.ARTIFACTS.FILES_EDITED] = [...filesEdited].slice(0, 100)

    // Environment capabilities (deterministic if project_scan ran — parse its output text)
    const projectScanSpan = toolSpans.find((s) => s.name === "project_scan")
    if (projectScanSpan) {
      const env = detectEnvFromProjectScan(projectScanSpan)
      if (env.dbtPresent != null) out[DE.ENV.DBT_PRESENT] = env.dbtPresent
      if (env.manifestPresent != null) out[DE.ENV.DBT_MANIFEST_PRESENT] = env.manifestPresent
      if (env.warehouseType) out[DE.ENV.WAREHOUSE_TYPE] = env.warehouseType
      if (env.toolsDetected.length > 0) out[DE.ENV.TOOLS_DETECTED] = env.toolsDetected
    }

    // Outcome.executed: was a dbt build/run/test actually performed?
    const ranDbt = toolSpans.some((s) => {
      if (s.name !== "bash") return false
      const inp = s.input as Record<string, unknown> | undefined
      const cmd = typeof inp?.command === "string" ? inp.command : ""
      return /\b(?:dbt|altimate-dbt)\s+(?:build|run|test|seed|snapshot)\b/i.test(cmd)
    })
    if (ranDbt) out[DE.OUTCOME.EXECUTED] = true

    // Outcome.change_applied: any write/edit spans?
    const changed = toolSpans.some((s) => s.name === "write" || s.name === "edit")
    if (changed) out[DE.OUTCOME.CHANGE_APPLIED] = true
  } catch {
    // best-effort
  }
  return out
}

// ---------------------------------------------------------------------------
// project_scan output parsing
// ---------------------------------------------------------------------------

type ScanEnv = {
  dbtPresent: boolean | undefined
  manifestPresent: boolean | undefined
  warehouseType: string | undefined
  toolsDetected: string[]
}

const WAREHOUSE_KEYWORDS: Array<[RegExp, string]> = [
  [/\bsnowflake\b/i, "snowflake"],
  [/\bbigquery\b/i, "bigquery"],
  [/\bpostgres\b/i, "postgres"],
  [/\bduckdb\b/i, "duckdb"],
  [/\bdatabricks\b/i, "databricks"],
  [/\bredshift\b/i, "redshift"],
  [/\bmysql\b/i, "mysql"],
  [/\bclickhouse\b/i, "clickhouse"],
]

const TOOL_KEYWORDS: Array<[RegExp, string]> = [
  [/\bairflow\b/i, "airflow"],
  [/\bdagster\b/i, "dagster"],
  [/\bprefect\b/i, "prefect"],
  [/\bsoda\b/i, "soda"],
  [/\bsqlmesh\b/i, "sqlmesh"],
  [/\bgreat[\s_-]?expectations\b/i, "great_expectations"],
  [/\bsqlfluff\b/i, "sqlfluff"],
]

function detectEnvFromProjectScan(span: TraceSpan): ScanEnv {
  const text = typeof span.output === "string" ? span.output : (span.output ? JSON.stringify(span.output) : "")
  const env: ScanEnv = {
    dbtPresent: undefined,
    manifestPresent: undefined,
    warehouseType: undefined,
    toolsDetected: [],
  }
  if (!text) return env

  // project_scan output uses ✓ / ✗ glyphs around "dbt Project" and "manifest.json"
  if (/✓\s*Project\s+"/i.test(text) || /✓\s*dbt\s+Project/i.test(text)) env.dbtPresent = true
  else if (/✗\s*(?:dbt\s+Project|No\s+dbt)/i.test(text)) env.dbtPresent = false

  if (/✓\s*manifest\.json/i.test(text)) env.manifestPresent = true
  else if (/✗\s*manifest\.json/i.test(text)) env.manifestPresent = false

  // Warehouse: look for adapter mention in profile
  for (const [re, name] of WAREHOUSE_KEYWORDS) {
    if (re.test(text)) {
      env.warehouseType = name
      break
    }
  }

  // Tools
  const seen = new Set<string>()
  for (const [re, name] of TOOL_KEYWORDS) {
    if (re.test(text)) seen.add(name)
  }
  env.toolsDetected = [...seen]

  return env
}
