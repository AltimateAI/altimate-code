import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectDbtProject } from "../tools/project-scan"

/**
 * Decide whether the user "already has a usable dbt setup" strongly enough
 * that the activation prompt should demote the "Open sample project"
 * option. Wraps the existing `detectDbtProject()` primitive with a couple
 * of secondary signals so a checked-out dbt repo without a resolvable
 * profile doesn't get treated the same as a fully-configured workspace.
 *
 * From the codex design consult: "a checked-out dbt repo is not
 * necessarily usable — missing profiles, env vars, adapter deps, or
 * warehouse creds are common. Do not equate project detection with
 * readiness." So the verdict distinguishes:
 *
 *   - "usable"                — project found AND profile resolvable →
 *                                connect their real thing, don't push sample
 *   - "detected-not-usable"   — project found, profile missing/broken →
 *                                still show sample AS an option, but lead
 *                                with "connect data" since a project exists
 *   - "nothing"               — no project found → lead with sample
 *
 * The caller uses this verdict to ORDER the activation-dialog options,
 * not to hide any of them.
 */

export type UsableSetupVerdict = "usable" | "detected-not-usable" | "nothing"

export interface UsableSetupSignals {
  dbtProjectFound: boolean
  /** Absolute path to the project root when found. */
  projectPath?: string
  /** Profile name referenced by dbt_project.yml (when parseable). */
  profileName?: string
  /** True when a profiles.yml exists AND we found an entry matching
   *  `profileName` in it. Doesn't validate that the credentials
   *  themselves are correct — a warehouse handshake would be a much
   *  more expensive probe. */
  profileResolvable: boolean
  /** Where we found the profile: project-local, DBT_PROFILES_DIR, or
   *  ~/.dbt/. undefined when profileResolvable=false. */
  profileFoundAt?: string
}

export interface UsableSetup {
  verdict: UsableSetupVerdict
  signals: UsableSetupSignals
}

export async function detectUsableSetup(cwd: string): Promise<UsableSetup> {
  const project = await detectDbtProject(cwd)

  // `detectDbtProject` returns `{found:true, path, ...}` on success, but the
  // interface types both fields as optional. Narrow here so the rest of the
  // function can pass `projectPath` into helpers that expect `string`.
  if (!project.found || !project.path) {
    return {
      verdict: "nothing",
      signals: { dbtProjectFound: false, profileResolvable: false },
    }
  }

  const profileName = project.profile
  const projectPath: string = project.path

  if (!profileName) {
    // Malformed dbt_project.yml (no profile: key) — treat as detected-
    // not-usable, since we can't reasonably promote a connect flow.
    return {
      verdict: "detected-not-usable",
      signals: { dbtProjectFound: true, projectPath, profileResolvable: false },
    }
  }

  const profileLocation = findProfileFor(profileName, projectPath)

  if (profileLocation) {
    return {
      verdict: "usable",
      signals: {
        dbtProjectFound: true,
        projectPath,
        profileName,
        profileResolvable: true,
        profileFoundAt: profileLocation,
      },
    }
  }

  return {
    verdict: "detected-not-usable",
    signals: {
      dbtProjectFound: true,
      projectPath,
      profileName,
      profileResolvable: false,
    },
  }
}

/**
 * Look for a `<profileName>:` top-level key in a profiles.yml file at
 * (in order of dbt's own precedence):
 *   1. `<projectDir>/profiles.yml` (project-local)
 *   2. `$DBT_PROFILES_DIR/profiles.yml`
 *   3. `~/.dbt/profiles.yml`
 *
 * We do NOT parse the whole YAML — a broadened line-based check is enough
 * to answer "is this profile defined here" without pulling in a YAML +
 * Jinja stack. The regex accepts:
 *   - Optional single or double quotes around the key.
 *   - Optional trailing content after the colon (inline mapping, value,
 *     comment, anchor) — dbt's schema requires the value to be a mapping,
 *     but from the presence-check standpoint any of those shapes means
 *     "the profile is declared".
 *
 * Known false-NEGATIVE cases we accept for v1:
 *   - Jinja `{% if %}`-wrapped profile blocks (rare — dbt renders Jinja
 *     before parsing profiles, so a real YAML+Jinja pass would resolve
 *     them; we don't).
 *   - Profile names embedded in YAML anchors that reference an earlier
 *     definition.
 *
 * Impact of a false-negative is bounded: verdict downgrades from "usable"
 * to "detected-not-usable" → the activation dialog leads with "sample"
 * instead of "connect data". User can still pick either option; nothing
 * breaks. Erring on the side of showing the sample is the safer bias when
 * detection is uncertain.
 */
function findProfileFor(profileName: string, projectDir: string): string | undefined {
  const candidates: string[] = []
  candidates.push(path.join(projectDir, "profiles.yml"))
  const envDir = process.env["DBT_PROFILES_DIR"]
  if (envDir) candidates.push(path.join(envDir, "profiles.yml"))
  candidates.push(path.join(os.homedir(), ".dbt", "profiles.yml"))

  // Top-level key (no leading whitespace) with optional matching quotes
  // and anything-or-nothing after the colon. `m` flag makes ^ match at
  // line starts, not just string start.
  const escName = escapeForRegExp(profileName)
  const nameRe = new RegExp(`^(["']?)${escName}\\1\\s*:(?:\\s.*)?$`, "m")

  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, "utf8")
      if (nameRe.test(content)) return candidate
    } catch {
      // File missing / unreadable — try the next candidate.
    }
  }
  return undefined
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
