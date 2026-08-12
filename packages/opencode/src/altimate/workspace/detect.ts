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

/** Sensible default workspace name from a remote URL — best-effort. Used to
 * prefill the workspace-name prompt in the CreateDialog and `altimate link`.
 * ``github.com/foo/bar.git`` → ``bar`` ; ``git@github.com:foo/bar.git`` → ``bar``. */
export function projectNameFromRemote(remote: string): string {
  const trimmed = remote.replace(/\.git$/, "").replace(/\/$/, "")
  const parts = trimmed.split(/[/:]/)
  return parts[parts.length - 1] || "workspace"
}
