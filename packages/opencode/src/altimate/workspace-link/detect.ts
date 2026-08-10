// altimate_change — WorkspaceLink feature. Shared "cheap hint" builder used by BOTH Path A
// (packages/opencode/src/altimate/plugin/altimate.ts, before the environment scan has run —
// CONTRACT.md §3's ordering caveat) and the on-demand `altimate link` command
// (packages/opencode/src/cli/cmd/link.ts, when there's no fresh scan-cache entry). Factored
// out once rather than duplicated in both call sites, per CONTRACT.md's own note that they
// use "the same hint-building" logic.
//
// Deliberately uses ONLY the cheap, non-LLM local detectors (detectGit/detectDbtProject) — no
// full `project_scan` tool invocation, no LLM round-trip. Best-effort: every field is
// optional/nullable (CONTRACT.md ASSUMPTION A5).
import { detectDbtProject, detectGit } from "@/altimate/tools/project-scan"
import type { WorkspaceLinkProjectHint } from "./types"

export async function buildProjectHint(directory: string): Promise<WorkspaceLinkProjectHint> {
  const [git, dbt] = await Promise.all([detectGit(), detectDbtProject(directory)])
  return {
    name: dbt.found ? dbt.name ?? null : null,
    remote: git.isRepo ? git.remoteUrl ?? null : null,
    // Adapter type isn't derivable from these cheap detectors alone — it requires parsing the
    // dbt manifest (native/dbt/helpers.ts), which is exactly the "full scan" this helper is
    // built to avoid. DISCOVERY.md §2 flags this as a known gap; left null here rather than
    // re-implementing manifest parsing outside the real project_scan tool.
    adapter: null,
    model_count: null,
    source_count: null,
    test_count: null,
  }
}
