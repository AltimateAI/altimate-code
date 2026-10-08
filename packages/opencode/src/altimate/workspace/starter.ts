// altimate_change - new file
//
// The "here is what this workspace has, what next?" message shown once a project is linked: in
// `altimate-code link`, in the TUI after a link, and to the IDE extension's chat through
// `GET /altimate/workspace/starter`. Fixed in format and built from the same data as the prompt's
// "What this Altimate Workspace provides" section, so it costs no model call (none of the user's
// tokens) and reads the same every time. Anything not known is left out, never shown as "none".
import { displayWorkspaceName } from "./workspace-name"
import { workspaceContents, type WorkspaceContents } from "./contents"

export interface Starter {
  workspace: string
  /** One line per thing the workspace provides, in a fixed order. */
  lines: string[]
  /** The same, in one short line for a dialog title: "3 skills · 2 knowledge documents · memory on". */
  summary: string
  /** Prompts the user can send as they are; at most `MAX_PROMPTS`. */
  prompts: string[]
  /** The whole message as plain text, for a terminal or a chat bubble. */
  text: string
}

const MAX_PROMPTS = 3
const MAX_LISTED_SKILLS = 8
const MAX_LISTED_DOCUMENTS = 5
/** The starter is shown once, after a link the user is watching, so it can wait for the service. */
const STARTER_WAIT_MS = { skills: 2_000, summary: 5_000 }

function list(names: string[], max: number): string {
  const shown = names.slice(0, max)
  const more = names.length - shown.length
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "")
}

function skillsLine(skills: WorkspaceContents["skills"]): string | null {
  if (skills === null) return "Skills: not synced to this project yet; run `altimate-code workspace sync` to fetch them."
  if (skills === "unknown") return null
  if (skills.length === 0) return "Skills: none yet. Add them in the workspace and they sync here."
  return `Skills (${skills.length}): ${list(skills.map((s) => s.name), MAX_LISTED_SKILLS)}`
}

function knowledgeLine(k: WorkspaceContents["knowledge"]): string | null {
  if (k === null) return null
  if (k.kind === "off") return "Knowledge: off for this workspace."
  if (k.kind === "all") return "Knowledge: every knowledge hub document you can read."
  if (k.names === null) return `Knowledge: ${k.selected} selected document${k.selected === 1 ? "" : "s"}.`
  if (k.names.length === 0) return "Knowledge: none. The documents this workspace selected no longer exist."
  return `Knowledge (${k.names.length}): ${list(k.names, MAX_LISTED_DOCUMENTS)}`
}

function integrationsLine(ids: string[] | null): string | null {
  if (ids === null) return null
  return ids.length === 0 ? "Integrations: none attached." : `Integrations: ${ids.join(", ")}`
}

function memoryLine(on: boolean | null): string | null {
  if (on === null) return null
  return on
    ? "Memory: on. What you teach Altimate Code is saved automatically and shared with your team in the CLI, the IDE and Studio."
    : "Memory: off for this workspace, so saved memory stays on this machine."
}

function hasKnowledge(k: WorkspaceContents["knowledge"]): boolean {
  return k !== null && (k.kind === "all" || (k.kind === "selected" && k.names?.length !== 0))
}

/** Suggestions in a fixed order, each only when the workspace has what it needs. */
function suggestions(contents: WorkspaceContents): string[] {
  const out: string[] = []
  const skills = Array.isArray(contents.skills) ? contents.skills.filter((s) => !s.unreadable) : []
  if (skills.length > 0) out.push("Which of our workspace skills fit this project?")
  if (hasKnowledge(contents.knowledge)) out.push("What are our best practices for this project?")
  const integrations = contents.integrations ?? []
  if (integrations.some((id) => id.toLowerCase().includes("snowflake")))
    out.push("Which Snowflake queries cost us most this week?")
  out.push("Explain this project and where to start.")
  return out.slice(0, MAX_PROMPTS)
}

function summaryOf(contents: WorkspaceContents): string {
  const parts: string[] = []
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  if (Array.isArray(contents.skills)) parts.push(plural(contents.skills.length, "skill"))
  const k = contents.knowledge
  if (k?.kind === "all") parts.push("all your knowledge hub documents")
  else if (k?.kind === "selected") parts.push(plural(k.names?.length ?? k.selected, "knowledge document"))
  else if (k?.kind === "off") parts.push("knowledge off")
  if (contents.integrations !== null)
    parts.push(contents.integrations.length === 0 ? "no integrations" : `integrations: ${contents.integrations.join(", ")}`)
  if (contents.memoryEnabled !== null) parts.push(contents.memoryEnabled ? "memory on" : "memory off")
  return parts.join(" · ")
}

/** Pure: the same contents always give the same message. */
export function renderStarter(workspaceName: string, contents: WorkspaceContents): Starter {
  const workspace = displayWorkspaceName(workspaceName) || "(unnamed)"
  const lines = [
    skillsLine(contents.skills),
    knowledgeLine(contents.knowledge),
    integrationsLine(contents.integrations),
    memoryLine(contents.memoryEnabled),
  ].filter((line): line is string => line !== null)
  const prompts = suggestions(contents)
  const text = [
    `You're working in the "${workspace}" Altimate workspace.`,
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "What do you want to do? For example:",
    ...prompts.map((p, i) => `  ${i + 1}. ${p}`),
  ].join("\n")
  return { workspace, lines, summary: summaryOf(contents), prompts, text }
}

/** The message wrapped to `width` columns for a framed terminal note, which grows to its longest line
 * rather than wrapping. A continuation keeps the indent of its list item. */
export function wrapStarter(text: string, width: number): string {
  const max = Math.max(20, width)
  return text
    .split("\n")
    .flatMap((line) => {
      if (Bun.stringWidth(line) <= max) return [line]
      const lead = line.match(/^\s*/)?.[0] ?? ""
      const indent = " ".repeat((line.match(/^\s*(?:- |\d+\. )?/)?.[0] ?? "").length)
      const out: string[] = []
      let current = lead
      for (const word of line.slice(lead.length).split(" ")) {
        const next = current.trim() ? `${current} ${word}` : current + word
        if (current.trim() && Bun.stringWidth(next) > max) {
          out.push(current)
          current = indent + word
        } else current = next
      }
      out.push(current)
      return out
    })
    .join("\n")
}

/** The starter for a linked project. `directory` is the project key the link was recorded under. */
export async function starterFor(
  directory: string,
  binding: { datamateId: number; datamateName: string },
  waitMs = STARTER_WAIT_MS,
): Promise<Starter> {
  return renderStarter(binding.datamateName, await workspaceContents(directory, binding.datamateId, waitMs))
}
