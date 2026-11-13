import fs from "fs"
import path from "path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { loadRawManifest, findModel } from "../native/dbt/helpers"
import { projectRoot } from "../native/connections/registry"
import { dbtAdapterFor } from "./dbt-adapter-access"
import { buildCountQuery, detectCtes, extractRowCount, lineOf, stripColumnList, type CteInfo } from "./cte-detect"

/** Folders a model search never enters. */
const SKIPPED_DIRS = new Set(["target", "dbt_packages", "dbt_modules", "node_modules", "logs", "venv", "site-packages"])

/** Deepest folder level the model search follows. */
const MAX_SEARCH_DEPTH = 12

/** Largest model file the tool reads. */
const MAX_MODEL_BYTES = 4 * 1024 * 1024

/** A CTE name without its column list, quotes or letter case, for comparing what the caller typed. */
function nameKey(name: string): string {
  return stripColumnList(name)
    .replace(/^["'`[]|["'`\]]$/g, "")
    .toLowerCase()
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Every `<name>.sql` under the project, outside the build folders. */
function findSqlFiles(root: string, name: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_SEARCH_DEPTH && !SKIPPED_DIRS.has(entry.name)) walk(full, depth + 1)
      } else if (entry.isFile() && entry.name === `${name}.sql`) {
        found.push(full)
      }
    }
  }
  walk(root, 0)
  return found.sort()
}

/** The model's source file: a project-relative path, the manifest's record of it, or a search by name. */
function modelFile(root: string, model: string): { file?: string; error?: string } {
  const realRoot = realpath(root)
  if (/\.sql$/i.test(model) || /[\\/]/.test(model)) {
    const candidate = path.resolve(realRoot, model)
    if (!inside(realRoot, realpath(candidate))) return { error: `${model} is outside the dbt project` }
    return fs.existsSync(candidate) ? { file: candidate } : { error: `no file ${model} in the dbt project` }
  }
  try {
    const manifest = loadRawManifest(path.join(realRoot, "target", "manifest.json"))
    const node = manifest?.nodes ? findModel(manifest.nodes, model) : null
    if (node?.original_file_path) {
      const candidate = path.resolve(realRoot, node.original_file_path)
      if (inside(realRoot, realpath(candidate)) && fs.existsSync(candidate)) return { file: candidate }
    }
  } catch {
    // A manifest that can't be read doesn't stop the search by name.
  }
  const name = model.startsWith("model.") ? (model.split(".").pop() ?? model) : model
  const matches = findSqlFiles(realRoot, name)
  if (matches.length === 1) return { file: matches[0] }
  if (matches.length === 0) return { error: `no model named ${model} in the dbt project` }
  const rel = matches.map((m) => path.relative(realRoot, m))
  return { error: `${model} matches ${matches.length} files (${rel.join(", ")}): pass the path` }
}

async function projectDir(): Promise<string | undefined> {
  const { getDbtProjectRoot } = await import("../native/connections/register")
  const root = await getDbtProjectRoot()
  if (root) return root
  const here = projectRoot()
  return fs.existsSync(path.join(here, "dbt_project.yml")) ? here : undefined
}

function failure(title: string, output: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_cte_profile: ${title}`, metadata: { success: false, ...extra }, output }
}

export const DbtCteProfileTool = Tool.define("dbt_cte_profile", {
  description:
    "List a dbt model's CTEs, or time one CTE with a row-count query. Without `cte` it returns the CTE names in source order and runs nothing (a read-only call works). With `cte` it runs `SELECT COUNT(*)` over that CTE and the CTEs before it in the same WITH clause on the warehouse, and returns the elapsed milliseconds and the row count; that run needs write permission (`--allow-write`) because it starts the dbt adapter and compiles the model. Each run recomputes the earlier CTEs, so a model of N CTEs costs N queries.",
  parameters: z.object({
    model: z
      .string()
      .describe("Model name, unique_id, or project-relative path to the model's .sql file (e.g. 'customers' or 'models/marts/customers.sql')"),
    cte: z.string().optional().describe("CTE to time; without it, the CTE list is returned"),
  }),
  async execute(args, ctx) {
    const root = await projectDir()
    if (!root) return failure("no dbt project", "No dbt project here: run from a dbt project folder.")
    const located = modelFile(root, args.model)
    if (!located.file) return failure("model not found", located.error ?? `no model named ${args.model}`)
    const size = fs.statSync(located.file).size
    if (size > MAX_MODEL_BYTES) return failure("model too large", `${args.model} is ${size} bytes; the largest file read is ${MAX_MODEL_BYTES}.`)
    const text = fs.readFileSync(located.file, "utf-8")
    const ctes = detectCtes(text)
    const file = path.relative(realpath(root), located.file)

    if (!args.cte) {
      const list = ctes.map((c) => ({
        name: stripColumnList(c.name),
        line: lineOf(text, c.nameStart) + 1,
        index: c.index,
        clause: c.withClauseStart,
      }))
      const output = list.length
        ? [`${list.length} CTE${list.length === 1 ? "" : "s"} in ${file}:`, ...list.map((c, i) => `${i + 1}. ${c.name} (line ${c.line})`)].join("\n")
        : `No CTEs in ${file}.`
      return {
        title: `dbt_cte_profile: ${list.length} CTE${list.length === 1 ? "" : "s"} in ${args.model}`,
        metadata: { success: true, model: args.model, file, ctes: list },
        output,
      }
    }

    const wanted = nameKey(args.cte)
    const matches = ctes.filter((c) => nameKey(c.name) === wanted)
    if (matches.length === 0) {
      const names = ctes.map((c) => stripColumnList(c.name)).join(", ")
      return failure("CTE not found", `${args.model} has no CTE named ${args.cte}${names ? `; it has: ${names}` : ""}.`, { model: args.model })
    }
    const target: CteInfo = matches[0]
    const query = buildCountQuery(text, ctes, target)
    if (!query) return failure("no query", `Could not build a count query for ${args.cte}.`, { model: args.model, cte: args.cte })

    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) {
      return failure("not run", `${access.reason}`, { model: args.model, cte: args.cte, refusal: access.refusal })
    }
    ctx.abort.throwIfAborted()
    const name = stripColumnList(target.name)
    const started = performance.now()
    try {
      const result = await access.adapter.immediatelyExecuteSQLWithLimit(query, `cte_profiler_${name}`, 1)
      const queryMs = Math.round(performance.now() - started)
      const rows = extractRowCount(result?.data)
      const note = matches.length > 1 ? ` (${matches.length} CTEs share this name; the first was timed)` : ""
      return {
        title: `dbt_cte_profile: ${name} ${queryMs} ms`,
        metadata: { success: true, model: args.model, cte: name, index: target.index, queryMs, rows },
        output: `${name}: ${queryMs} ms, ${rows} row${rows === 1 ? "" : "s"}${note}`,
      }
    } catch (e) {
      if (ctx.abort.aborted) throw e
      const message = e instanceof Error ? e.message : String(e)
      return failure("query failed", `The count query for ${name} failed: ${message}`, { model: args.model, cte: name })
    }
  },
})
