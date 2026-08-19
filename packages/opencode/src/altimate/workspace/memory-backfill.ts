// altimate_change - new file
//
// Seeds a freshly bound workspace with the memory this machine already holds.
// Without it only blocks written AFTER the bind would ever reach the store, and
// a user's existing memory would stay invisible in the workspace.
//
// Lives in its own module rather than inside ./state.ts because the sweep needs
// MemoryStore, whose write path already reaches ./memory-sync — importing it
// directly from state.ts would close an eval-order cycle
// (state -> backfill -> memory -> store -> memory-sync -> state). state.ts
// reaches this through a lazy dynamic import instead.
import { MemoryStore } from "@/memory/store"
import { Log } from "@/altimate/util/log"
import { backfill, isEnabled } from "./memory-sync"
import type { CachedBinding } from "./state"

const log = Log.create({ service: "altimate-workspace-memory-backfill" })

/** Push every non-expired local block. Throttled and resumable inside
 * ``backfill`` — blocks already synced at their current payload are skipped, so
 * repeated binds cost index reads rather than uploads.
 *
 * Covers both scopes: project blocks attach to the workspace just bound, and
 * global blocks go up account-level. A bind is the only moment global memory is
 * swept; blocks written later ride the ordinary per-write mirror. */
export async function backfillOnBind(directory: string, binding: CachedBinding): Promise<void> {
  if (!isEnabled()) return
  try {
    // The directory and binding are passed in rather than rediscovered. The
    // `link` subcommand binds from a plain yargs handler with no instance
    // context, so resolving project scope from the ambient instance throws
    // there — silently, because this catch turns it into a log line while the
    // CLI still prints "Linked". Reading project memory was the entire point.
    const blocks = await MemoryStore.listAll({ directory })
    if (blocks.length === 0) return
    const result = await backfill(blocks, binding)
    log.info("workspace memory seeded after bind", result)
  } catch (err) {
    log.warn("workspace memory backfill after bind failed", { err: String(err) })
  }
}
