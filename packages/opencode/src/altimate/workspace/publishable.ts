// altimate_change - new file
//
// Which of the skills this project can reach may be published to its workspace, for the serve
// routes the IDE extension calls. The CLI's `skill publish` and the TUI's "Publish to workspace"
// row apply the same rules inline (`skillSource`, `isManagedSkill`, `assertProjectSkill`); the
// refusal wording here matches theirs so a user moving between surfaces reads the same thing.
import path from "path"
import { skillSource } from "@/cli/cmd/skill-helpers"
import { assertProjectSkill, IDE_DELIVERED_MARKER, isManagedSkill } from "./skill-publish"

export type PublishEligibility = "publishable" | "builtin" | "personal" | "workspace" | "outside-project"

/** The boundary a skill must lie within: the worktree, since discovery walks up to it — except for
 * a project with no git, whose worktree is the sentinel `/`, which would contain everything. */
export function projectRootFor(directory: string, worktree: string): string {
  return worktree !== "/" ? worktree : directory
}

/** Whether a skill at `location` (its `SKILL.md`) may be published from `projectDirectory`. */
export function publishEligibility(location: string, projectDirectory: string, projectRoot: string): PublishEligibility {
  if (!path.isAbsolute(location) || skillSource(location) === "builtin") return "builtin"
  if (skillSource(location) === "global") return "personal"
  const skillDirectory = path.dirname(location)
  if (isManagedSkill(projectDirectory, skillDirectory)) return "workspace"
  try {
    assertProjectSkill(projectRoot, skillDirectory)
  } catch {
    return "outside-project"
  }
  return "publishable"
}

/** Why a skill cannot be published, in the words the CLI uses, or null when it can. */
export function explainIneligible(name: string, location: string, eligibility: PublishEligibility): string | null {
  switch (eligibility) {
    case "publishable":
      return null
    case "builtin":
      return `"${name}" is a built-in skill and cannot be published.`
    case "personal":
      return (
        `"${name}" is a personal skill (${path.dirname(location)}), not one of this project's. ` +
        `Copy it into the project's skills directory to publish it.`
      )
    case "workspace":
      return (
        `"${name}" is a skill this workspace sent to you, not one you authored. ` +
        `Publishing it would send the workspace's own skill back to it. ` +
        `If you copied it to make your own, rename it and delete any ${IDE_DELIVERED_MARKER} in its folder.`
      )
    case "outside-project":
      return `"${name}" is not inside this project (${path.dirname(location)}), so it cannot be published from here.`
  }
}
