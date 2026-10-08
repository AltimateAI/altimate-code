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
import { isWithin, snapshotProjectOf } from "./workspace/snapshot-path"

/** Highest precedence first, the order `SKILL_PRECEDENCE_RULE` states. */
export const SKILL_SOURCES = ["workspace", "project", "built-in", "personal", "other"] as const
export type SkillSource = (typeof SKILL_SOURCES)[number]

/** Altimate-shipped: an embedded skill, or one installed with Altimate Code. Given `home`, an installed copy
 * counts only inside `<home>/.altimate/builtin`, where it is installed; without it (skill-use telemetry, which
 * has no home to hand) the `.altimate/builtin` segment anywhere is enough. */
export function isBuiltinSkillLocation(location: string, home?: string): boolean {
  const normalized = location.replace(/\\/g, "/")
  if (normalized.startsWith("builtin:") || normalized === "<built-in>") return true
  if (/\/node_modules\/(@altimateai\/|altimate-code\/)/.test(normalized)) return true
  if (home !== undefined) return path.isAbsolute(location) && isWithin(path.join(home, ".altimate", "builtin"), location)
  return normalized.includes("/.altimate/builtin/")
}

export interface SkillSourceContext {
  projectRoot?: string
  home: string
  /** The skill file's resolved path, when it differs from `location` (a symlink). */
  real?: string
  /** The project root's resolved path. */
  realProjectRoot?: string
}

/**
 * - workspace: this project's synced workspace snapshot. Judged on both the matched and the resolved path, and
 *   only for this project's own snapshot: a configured path or a symlink into another project's snapshot, or out
 *   of this one, is "other", not the workspace this project is linked to.
 * - project: inside the project — `.claude/skills`, `.agents/skills`, `.altimate-code/skills`.
 * - built-in: ships with Altimate Code.
 * - personal: the user's own folders under their home directory.
 * - other: anything else, such as a configured path outside both.
 *
 * A project opened at the home directory itself would claim every personal skill, so there the
 * home directory is not treated as a project.
 */
export function skillSource(location: string, ctx: SkillSourceContext): SkillSource {
  if (isBuiltinSkillLocation(location, ctx.home)) return "built-in"
  if (!path.isAbsolute(location)) return "other"
  const real = ctx.real ?? location
  const matchedProject = snapshotProjectOf(location)
  const realProject = snapshotProjectOf(real)
  if (matchedProject !== null || realProject !== null) {
    const ours = (project: string | null, root: string | undefined) =>
      project !== null && root !== undefined && path.resolve(project) === path.resolve(root)
    return ours(matchedProject, ctx.projectRoot) && ours(realProject, ctx.realProjectRoot ?? ctx.projectRoot)
      ? "workspace"
      : "other"
  }
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
