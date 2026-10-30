// altimate_change - new file
//
// Whether the `tool` CLI exposes the linked-workspace tools, and the workspace section of `tool context`.
// An explicit flag always wins; without one the tools are on exactly when the project is linked.
import fs from "node:fs/promises"
import path from "node:path"
import { readLocalBinding } from "../workspace/state"
import * as WorkspaceClient from "../workspace/client"
import * as SkillSync from "../workspace/skill-sync"

/** Whether the project in `directory` is linked to a workspace, judged from the saved link alone: every CLI call asks,
 * so it makes no network request. The workspace tools validate the link when one is called. Unlinked or signed out read as no. */
export async function projectIsLinked(directory: string): Promise<boolean> {
  try {
    return (await readLocalBinding(directory)) !== null
  } catch {
    return false
  }
}

/** The effective `--workspace-tools` value: the flag when given, otherwise whether the project is linked. */
export async function resolveWorkspaceTools(
  flag: boolean | undefined,
  directory: string,
  linked: (directory: string) => Promise<boolean> = projectIsLinked,
): Promise<boolean> {
  return flag ?? (await linked(directory))
}

/** One top-level scalar of a skill's frontmatter, folded to one line; empty when absent. */
export function skillField(markdown: string, field: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) return ""
  const lines = match[1].split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`${field}:`))
  if (start < 0) return ""
  const first = lines[start].slice(field.length + 1).trim()
  const parts = /^[>|][+-]?$/.test(first) ? [] : [first]
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break
    parts.push(line.trim())
  }
  return parts.join(" ").replace(/^(["'])(.*)\1$/, "$2").trim()
}

export const skillDescription = (markdown: string) => skillField(markdown, "description")

/** The first sentence-sized slice of a description, so a skill list stays one line per skill. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? flat.slice(0, 159) + "…" : flat
}

/**
 * The workspace part of `tool context`: the workspace name, each team skill with its description, and the three
 * workspace tools with the descriptions `mcp serve` advertises. Undefined when the project is not linked or the
 * workspace cannot be read, so the plain context is printed instead.
 */
export async function workspaceContextSection(directory: string): Promise<string | undefined> {
  try {
    const { workspace, skills } = await WorkspaceClient.context(directory)
    const root = SkillSync.snapshotRoot(directory)
    const described = await Promise.all(
      skills.map(async (name) => {
        const text = await fs.readFile(path.join(root, name, "SKILL.md"), "utf8").catch(() => "")
        const title = skillField(text, "name")
        const label = title && title !== name ? `${title} (workspace_skill name: ${name})` : name
        const description = oneLine(skillDescription(text))
        return description ? `- ${label}: ${description}` : `- ${label}`
      }),
    )
    const { createWorkspaceAdapter } = await import("../mcp-server/workspace")
    const adapter = await createWorkspaceAdapter(directory)
    try {
      const tools = adapter.tools.map((tool) => `- ${tool.name}: ${tool.description ?? ""}`)
      return [
        `Linked workspace: ${workspace.name}`,
        ...(described.length ? ["", "Workspace skills (read one with workspace_skill):", ...described] : []),
        "",
        "Workspace tools (run with `tool run <name> --args <json>`; start with workspace_context):",
        ...tools,
      ].join("\n")
    } finally {
      await adapter.close()
    }
  } catch {
    return undefined
  }
}
