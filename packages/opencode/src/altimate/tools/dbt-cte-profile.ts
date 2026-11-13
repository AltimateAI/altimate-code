import fs from "fs"
import path from "path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { loadRawManifest, findModel } from "../native/dbt/helpers"
import { projectRoot } from "../native/connections/registry"
import { isQueryTimeoutError } from "@altimateai/drivers/types"
import { executeQuery } from "../native/query-execution"
import { dbtAdapterFor } from "./dbt-adapter-access"
import { buildCountQuery, detectCtes, extractRowCount, stripColumnList, unclosedJinjaBlock, type CteInfo } from "./cte-detect"

/** Folders a model search never enters. */
const SKIPPED_DIRS = new Set(["target", "dbt_packages", "dbt_modules", "node_modules", "logs", "venv", "site-packages"])

/** Deepest folder level the model search follows. */
const MAX_SEARCH_DEPTH = 12

/** Largest model file the tool reads. */
const MAX_MODEL_BYTES = 4 * 1024 * 1024

/** A CTE name without its column list or surrounding quotes, quote escapes undone. */
function bareName(name: string): string {
  const plain = stripColumnList(name)
  const quote = plain[0]
  if ((quote === '"' || quote === "`") && plain.length > 1 && plain.endsWith(quote)) return plain.slice(1, -1).replaceAll(quote + quote, quote)
  if (quote === "[" && plain.endsWith("]")) return plain.slice(1, -1)
  return plain
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
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

/** The model's source file: a project-relative or absolute `.sql` path, the manifest's record of a name or unique_id, or a search by name. */
function modelFile(root: string, model: string): { file?: string; error?: string } {
  const realRoot = realpath(root)
  if (/\.sql$/i.test(model) || /[\\/]/.test(model)) {
    const candidate = path.resolve(realRoot, model)
    if (!/\.sql$/i.test(candidate)) return { error: `${model} is not a .sql file` }
    if (!inside(realRoot, realpath(candidate))) return { error: `${model} is outside the dbt project` }
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? { file: realpath(candidate) } : { error: `no file ${model} in the dbt project` }
  }
  try {
    const manifest = loadRawManifest(path.join(realRoot, "target", "manifest.json"))
    const own = /^name:\s*['"]?([\w-]+)/m.exec(fs.readFileSync(path.join(realRoot, "dbt_project.yml"), "utf-8"))?.[1]
    let node = manifest?.nodes ? findModel(manifest.nodes, model) : null
    if (node && !model.startsWith("model.")) {
      // The project's own model of that name comes before a package's; versions of one model share a name and the manifest can't say which is meant.
      const named = Object.values<any>(manifest.nodes).filter((n) => n.resource_type === "model" && n.name === model)
      const mine = named.filter((n) => !own || !n.package_name || n.package_name === own)
      const pool = mine.length > 0 ? mine : named
      if (pool.length > 1) return { error: `${model} matches ${pool.length} models (${pool.map((n) => n.unique_id).join(", ")}): pass the path of the one to profile` }
      node = pool[0]
    }
    if (node?.original_file_path) {
      // dbt records the path relative to the model's own package: only the project's models can be read here.
      if (node.package_name && own && node.package_name !== own) return { error: `${model} belongs to the package ${node.package_name}: pass the path of its .sql file` }
      const candidate = path.resolve(realRoot, node.original_file_path)
      if (inside(realRoot, realpath(candidate)) && fs.existsSync(candidate)) return { file: realpath(candidate) }
    }
  } catch {
    // A manifest that can't be read doesn't stop the search by name.
  }
  // A unique_id names one model of one package: only the manifest can say which file it is.
  if (model.startsWith("model.")) return { error: `${model} is not in target/manifest.json: run dbt compile, or pass the model's name or path` }
  const matches = findSqlFiles(realRoot, model)
  if (matches.length === 1) return { file: realpath(matches[0]) }
  if (matches.length === 0) return { error: `no model named ${model} in the dbt project` }
  const rel = matches.map((m) => path.relative(realRoot, m))
  return { error: `${model} matches ${matches.length} files (${rel.join(", ")}): pass the path` }
}

/** The dbt project of the session's directory; else the one the dbt adapter is set up for. */
async function projectDir(): Promise<string | undefined> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const here = findProjectRoot(projectRoot())
  if (here) return here
  const { getDbtProjectRoot } = await import("../native/connections/register")
  return getDbtProjectRoot()
}

function failure(title: string, output: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_cte_profile: ${title}`, metadata: { success: false, error: output, ...extra }, output }
}

export const DbtCteProfileTool = Tool.define("dbt_cte_profile", {
  description:
    "List a dbt model's CTEs, or time one CTE with a row-count query. Without `cte` or `position` it returns the CTE names in source order (name, line, position) and runs nothing, so a read-only call works. With one of them it runs `SELECT COUNT(*)` over that CTE and the CTEs before it in the same WITH clause on the warehouse, and returns the elapsed milliseconds and the row count; that run needs write permission (`--allow-write`) because it starts the dbt adapter and compiles the model. Each run recomputes the earlier CTEs, so a model of N CTEs costs N queries. Only the model's own top-level WITH clause is read: a WITH inside a CTE body is part of that CTE.",
  parameters: z.object({
    model: z
      .string()
      .describe("Model name, unique_id, or project-relative or absolute path to the model's .sql file (e.g. 'customers' or 'models/marts/customers.sql')"),
    cte: z.string().optional().describe("CTE to time, by name; without it (and without `position`), the CTE list is returned"),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The CTE's position in the list (0-based); needed when several CTEs share a name"),
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

    if (args.cte === undefined && args.position === undefined) {
      // The CTEs come in source order: count the lines once, not once per CTE.
      let line = 1
      let counted = 0
      const lineAt = (offset: number) => {
        for (; counted < offset; counted++) if (text[counted] === "\n") line++
        return line
      }
      const list = ctes.map((c, position) => ({
        name: stripColumnList(c.name),
        line: lineAt(c.nameStart),
        index: c.index,
        clause: c.withClauseStart,
        position,
      }))
      const output = list.length
        ? [`${list.length} CTE${list.length === 1 ? "" : "s"} in ${file}:`, ...list.map((c) => `${c.position + 1}. ${c.name} (line ${c.line})`)].join("\n")
        : `No CTEs in ${file}.`
      return {
        title: `dbt_cte_profile: ${list.length} CTE${list.length === 1 ? "" : "s"} in ${args.model}`,
        metadata: { success: true, model: args.model, file, ctes: list },
        output,
      }
    }

    const names = ctes.map((c) => stripColumnList(c.name)).join(", ")
    let target: CteInfo | undefined
    if (args.position !== undefined) {
      target = ctes[args.position]
      if (!target) return failure("CTE not found", `${args.model} has ${ctes.length} CTEs: there is none at position ${args.position}.`, { model: args.model })
      if (args.cte !== undefined && bareName(target.name) !== bareName(args.cte))
        return failure("CTE not found", `The CTE at position ${args.position} of ${args.model} is ${stripColumnList(target.name)}, not ${args.cte}.`, { model: args.model })
    } else {
      // The name as typed wins; letter case only decides when nothing matches it exactly.
      const wanted = bareName(args.cte ?? "")
      const exact = ctes.filter((c) => bareName(c.name) === wanted)
      const matches = exact.length > 0 ? exact : ctes.filter((c) => bareName(c.name).toLowerCase() === wanted.toLowerCase())
      if (matches.length === 0)
        return failure("CTE not found", `${args.model} has no CTE named ${args.cte}${names ? `; it has: ${names}` : ""}.`, { model: args.model })
      if (matches.length > 1) {
        const at = matches.map((c) => ctes.indexOf(c)).join(", ")
        return failure("CTE ambiguous", `${args.model} has ${matches.length} CTEs that match ${args.cte} (positions ${at}): pass position.`, { model: args.model })
      }
      target = matches[0]
    }
    const query = buildCountQuery(text, ctes, target)
    const name = stripColumnList(target.name)
    if (!query) {
      const block = unclosedJinjaBlock(text.substring(0, target.withClauseStart))
      return failure(
        "no query",
        block
          ? `${name} sits in a WITH clause of ${args.model} that is one branch of a Jinja {% ${block} %} block, so it has no query of its own to count.`
          : `${name} is in a second WITH clause of ${args.model}, which has no query of its own to count.`,
        { model: args.model, cte: name },
      )
    }
    const block = unclosedJinjaBlock(query)
    if (block) return failure("no query", `${name} is inside a Jinja {% ${block} %} block of ${args.model}, which cannot be cut off at that CTE and stay valid: compile the model and profile the compiled SQL, or move the WITH out of the block.`, { model: args.model, cte: name })

    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) return failure("not run", access.reason ?? "the dbt adapter is not available", { model: args.model, cte: name, refusal: access.refusal })
    const adapter = access.adapter
    ctx.abort.throwIfAborted()
    const started = performance.now()
    try {
      // The adapter has no cancel of its own: the run's timeout, budget and abort end the wait, not the query.
      const result: { data?: Record<string, unknown>[] } = await executeQuery({ type: "dbt" }, {}, { signal: ctx.abort, sessionID: ctx.sessionID }, () =>
        adapter.immediatelyExecuteSQLWithLimit(query, `cte_profiler_${name}`, 1),
      )
      const queryMs = Math.round(performance.now() - started)
      const rows = extractRowCount(result?.data)
      return {
        title: `dbt_cte_profile: ${name} ${queryMs} ms`,
        metadata: { success: true, model: args.model, cte: name, index: target.index, position: ctes.indexOf(target), queryMs, rows },
        output: `${name}: ${queryMs} ms, ${rows} row${rows === 1 ? "" : "s"}`,
      }
    } catch (e) {
      if (ctx.abort.aborted) throw e
      const message = e instanceof Error ? e.message : String(e)
      // A timeout gives up the wait, not the query: it may still be running on the warehouse.
      const timedOut = isQueryTimeoutError(e)
      return failure(timedOut ? "timed out" : "query failed", `The count query for ${name} ${timedOut ? "timed out and may still be running on the warehouse" : "failed"}: ${message}`, { model: args.model, cte: name, ...(timedOut && { timedOut }) })
    }
  },
})
