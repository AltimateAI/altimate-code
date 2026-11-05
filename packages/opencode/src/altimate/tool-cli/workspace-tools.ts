// altimate_change - new file
//
// Whether the `tool` CLI exposes the linked-workspace tools, and the workspace section of `tool context`.
// An explicit flag always wins; without one the tools are on exactly when the project is linked.
import { readLocalBinding } from "../workspace/state"
import * as WorkspaceClient from "../workspace/client"
import { workspaceLabel } from "../workspace/workspace-name"

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

/** Workspace-authored text as one inert line: control characters and line separators become spaces, whitespace
 * collapses and the length is bounded, so it cannot start a new line or forge a list entry. */
function oneLine(text: string, max = 160): string {
  const flat = text
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const points = Array.from(flat)
  return points.length > max ? points.slice(0, max - 1).join("") + "…" : flat
}

/**
 * The workspace part of `tool context`: the workspace name, each team skill with its description, and the three
 * workspace tools with the descriptions `mcp serve` advertises. Undefined when the project is not linked or the
 * workspace cannot be read, so the plain context is printed instead.
 */
export async function workspaceContextSection(directory: string): Promise<string | undefined> {
  try {
    const { workspace, skills } = await WorkspaceClient.context(directory)
    const read = await Promise.all(
      skills.map(async (name) => {
        const text = await WorkspaceClient.readSkill(directory, name, workspace.token).catch(() => undefined)
        if (text === undefined) return undefined
        const title = oneLine(skillField(text, "name"), 80)
        const label = title && title !== name ? `${title} (workspace_skill name: ${name})` : name
        const description = oneLine(skillDescription(text))
        return description ? `- ${label}: ${description}` : `- ${label}`
      }),
    )
    const described = read.filter((line): line is string => line !== undefined)
    const { createWorkspaceAdapter } = await import("../mcp-server/workspace")
    const adapter = await createWorkspaceAdapter(directory)
    try {
      const tools = adapter.tools.map((tool) => `- ${tool.name}: ${tool.description ?? ""}`)
      return [
        `Linked workspace: ${workspaceLabel(workspace.name, String(workspace.id))}`,
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
