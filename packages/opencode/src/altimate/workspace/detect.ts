// altimate_change - new file
//
// Cheap, sync git-remote detection for the workspace-binding flow. Shared by
// the TuiPlugin (packages/opencode/src/plugin/tui/altimate/workspace.tsx) and
// the `altimate link` CLI subcommand so both entry points identify projects
// identically. Reuses the credential-scrubbing helper the ProjectScan tool
// exports (../tools/project-scan.ts) so an HTTPS remote with basic-auth
// embedded in the RFC 3986 userinfo component (e.g. the `<userinfo>@host`
// form of `https://<userinfo>@github.com/...`) never reaches the server or
// the local cache in clear.
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"
import { stripGitRemoteCredentials } from "../tools/project-scan"

export function detectProjectRemote(directory: string): string | undefined {
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 3000,
    })
    if (r.status !== 0 || !r.stdout) return undefined
    return stripGitRemoteCredentials(r.stdout.trim())
  } catch {
    return undefined
  }
}

/** Project identity for the binding system. Prefers ``repo_remote`` when the
 * project has a git remote (stronger identity — survives directory moves); falls
 * back to ``project_path`` (absolute, symlink-resolved directory path) for
 * projects without one (materialized sample scaffolds, fresh scratch dirs).
 *
 * Both fields can be populated simultaneously; callers pick which to use for
 * lookup or send both to create/bind (server uses whichever it needs for its
 * partial unique index). At least one field is always populated — falling back
 * to the raw ``directory`` argument keeps the "no remote AND unresolvable path"
 * degenerate case from returning empty. */
export function resolveProjectIdentifier(directory: string): {
  repoRemote?: string
  projectPath: string
} {
  const repoRemote = detectProjectRemote(directory)
  let projectPath: string
  try {
    projectPath = realpathSync(path.resolve(directory))
  } catch {
    projectPath = path.resolve(directory)
  }
  return repoRemote ? { repoRemote, projectPath } : { projectPath }
}

/** Sensible default workspace name from a remote URL — best-effort. Used to
 * prefill the workspace-name prompt in the CreateDialog and `altimate link`.
 * ``github.com/foo/bar.git`` → ``bar`` ; ``git@github.com:foo/bar.git`` → ``bar``. */
export function projectNameFromRemote(remote: string): string {
  const trimmed = remote.replace(/\.git$/, "").replace(/\/$/, "")
  const parts = trimmed.split(/[/:]/)
  return parts[parts.length - 1] || "workspace"
}

/** Fallback name source when the project has no git remote — uses the directory's
 * basename (e.g. ``/Users/x/sample-dbt-project`` → ``sample-dbt-project``). */
export function projectNameFromPath(projectPath: string): string {
  const base = path.basename(projectPath.replace(/\/$/, ""))
  return base || "workspace"
}
