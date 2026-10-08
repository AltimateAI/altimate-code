// altimate_change - new file
//
// Where a skill came from, shown to the model next to each listed skill. Without it a skill the
// linked workspace's members added, one the repository carries, a built-in and one in some other
// team's folder all looked the same, and with near-duplicates in the catalog the agent asked "which
// team's policy?" or explored the repo for clues instead of loading the workspace's own skill.
// The skill-routing measurement went from 4/16 to 16/16 with a source label plus one precedence rule.
//
// Decided by the skill's location, which Altimate Code chose when it found the file; nothing in the
// skill's own text can change it. Dependency-free like ./workspace/snapshot-path, which skill
// discovery also imports.
import path from "path"
import { isInWorkspaceSnapshot, isWithin } from "./workspace/snapshot-path"

/** Highest precedence first, the order `SKILL_PRECEDENCE_RULE` states. */
export const SKILL_SOURCES = ["workspace", "project", "built-in", "personal", "other"] as const
export type SkillSource = (typeof SKILL_SOURCES)[number]

export function isBuiltinSkillLocation(location: string): boolean {
  const normalized = location.replace(/\\/g, "/")
  return (
    normalized.startsWith("builtin:") ||
    normalized === "<built-in>" ||
    /\/node_modules\/(@altimateai\/|altimate-code\/)/.test(normalized) ||
    normalized.includes("/.altimate/builtin/")
  )
}

/**
 * - workspace: the synced snapshot of the workspace this project is linked to (discovery serves a
 *   snapshot only to the account that fetched it, so any snapshot skill listed is this link's).
 * - project: inside the project — `.claude/skills`, `.agents/skills`, `.altimate-code/skills`.
 * - built-in: ships with Altimate Code.
 * - personal: the user's own folders under their home directory.
 * - other: anything else, such as a configured path outside both.
 *
 * A project opened at the home directory itself would claim every personal skill, so there the
 * home directory is not treated as a project.
 */
export function skillSource(location: string, ctx: { projectRoot?: string; home: string }): SkillSource {
  if (isBuiltinSkillLocation(location)) return "built-in"
  if (!path.isAbsolute(location)) return "other"
  if (isInWorkspaceSnapshot(location)) return "workspace"
  const home = path.resolve(ctx.home)
  if (ctx.projectRoot && path.resolve(ctx.projectRoot) !== home && isWithin(ctx.projectRoot, location)) return "project"
  if (isWithin(home, location)) return "personal"
  return "other"
}

/** The rule that goes with the labels, stated once in the skills preamble. */
export const SKILL_PRECEDENCE_RULE = [
  'Each skill below carries a `source` that Altimate Code set from where it found the skill: "workspace" (added by',
  'the team in the Altimate workspace this project is linked to), "project" (in this repository), "built-in" (ships',
  'with Altimate Code), "personal" (the user\'s own folders), or "other". When more than one skill fits a task,',
  "load the one from the highest source in that order, rather than a lower one with a similar purpose, and do not",
  "ask the user which team's skill to use. Use a lower source only when nothing higher covers the task.",
].join("\n")
