import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const ROUTING_START = "<!-- altimate-code:routing start -->"
export const ROUTING_END = "<!-- altimate-code:routing end -->"

/** The managed routing block, markers included, without a trailing newline. */
export function routingBlock(): string {
  return [
    ROUTING_START,
    "## Data work in this project",
    "",
    "This project's warehouses and dbt project are connected to Altimate Code through its CLI. When a request needs warehouse data or schema, column lineage, downstream impact, PII checks, data diffs or warehouse cost, use the Altimate Code CLI instead of ad-hoc database clients:",
    "",
    "- Run `altimate-code tool context` once, then `altimate-code tool run <tool> --args '<json>'`. Find a tool with `altimate-code tool list` and its arguments with `altimate-code tool schema <tool>`. It uses the configured connections and is read-only by default.",
    "- Long multi-step jobs (dbt builds, migrations, backfills): `altimate-code run \"<task>\"`.",
    "- Code edits, docs, tests and git work that need no warehouse data or lineage: use the normal tools.",
    ROUTING_END,
  ].join("\n")
}

/**
 * Returns `content` with the managed block created or replaced in place. Text outside the
 * markers is never altered; a new block is appended after a blank line.
 */
export function applyRoutingBlock(content: string): string {
  const block = routingBlock()
  // The start nearest the end marker, so an orphaned start marker never widens the replaced span.
  const end = content.indexOf(ROUTING_END)
  const start = end === -1 ? -1 : content.lastIndexOf(ROUTING_START, end)
  if (start !== -1 && end !== -1) return content.slice(0, start) + block + content.slice(end + ROUTING_END.length)
  if (content.trim() === "") return block + "\n"
  return content.replace(/\n*$/, "\n\n") + block + "\n"
}

/** Creates or updates `<directory>/CLAUDE.md`. Returns whether the file changed. */
export async function writeRoutingBlock(directory: string): Promise<boolean> {
  const file = path.join(directory, "CLAUDE.md")
  const current = existsSync(file) ? await readFile(file, "utf8") : ""
  const next = applyRoutingBlock(current)
  if (next === current) return false
  await writeFile(file, next)
  return true
}
