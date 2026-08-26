// altimate_change - new file
//
// Launch-time --workspace <name> resolver. Runs once per process, on the
// TUI's main thread (from ``cli/cmd/tui.ts``) before the worker subprocess
// starts, so its ``UI.println`` messages reach the user's terminal cleanly.
//
// Contract (matches AI-8504 Item #1 wording):
// - The flag is same-directory-only. Resolution walks THIS directory's
//   local binding and nothing else — no backend-wide workspace-name search,
//   no fuzzy match. An unresolvable name is an honest printed error, never
//   a silent fallback to a different workspace.
// - If the requested name doesn't match this directory's linked workspace,
//   print a note and continue with the currently-linked one anyway (the
//   ticket calls this out explicitly). A mismatch is a warning, not a
//   session abort.
// - MUST NEVER block launch. Every failure path (missing binding, network
//   failure inside readLocalBinding, malformed cache) prints and returns —
//   nothing here calls ``process.exit`` or throws past the caller.
//
// Drift detection at launch (AI-8504 Item #2) is deliberately NOT
// implemented here; that ships separately once the backend PATCH-binding
// endpoint lands.
import { Flag } from "@opencode-ai/core/flag/flag"
import { UI } from "@/cli/ui"
import { readLocalBinding, type CachedBinding } from "@/altimate/workspace/state"
import { setResolvedWorkspaceId } from "@/altimate/workspace/session-context"

/** Case-insensitive, whitespace-trimmed match of the CLI's ``--workspace``
 * argument against the binding's stored workspace name. No fuzzy match; a
 * shorter substring is not a hit. */
export function nameMatches(name: string, binding: CachedBinding): boolean {
  const needle = name.trim().toLowerCase()
  return binding.datamateName.toLowerCase() === needle
}

export async function resolveWorkspaceForLaunch(
  directory: string,
  explicitName: string | undefined,
): Promise<void> {
  // Gate on the pilot flag so the flag is invisible to non-opted-in users
  // even if they discover it via ``--help``. Silent when opted out — no
  // error message that would leak the pilot's existence.
  if (!Flag.ALTIMATE_WORKSPACE) return
  if (explicitName === undefined) return

  const binding = await readLocalBinding(directory).catch(() => null)
  if (!binding) {
    // Can't attach to what isn't linked. Fail-fast with a message pointing at
    // the fix; do NOT set the env var (consumers will fall through to their
    // default resolution).
    UI.error(
      `No workspace is linked in this directory. Run \`altimate-code link\` ` +
        `first, or drop --workspace to continue with default resolution.`,
    )
    return
  }

  if (!nameMatches(explicitName, binding)) {
    // Per AI-8504 spec: print a note and continue with the currently-linked
    // workspace rather than aborting. The flag is a sanity check, not a
    // hard override.
    UI.println(
      `Note: --workspace "${explicitName}" was requested, but this directory ` +
        `is linked to "${binding.datamateName}" — attaching to ` +
        `"${binding.datamateName}" since that's what's linked here.`,
    )
  }

  setResolvedWorkspaceId(binding.datamateId)
  UI.println(`Attached to workspace "${binding.datamateName}".`)
}
