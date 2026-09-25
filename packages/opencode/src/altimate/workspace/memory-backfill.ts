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
import { backfill, isEnabled, memoryEnabledCached } from "./memory-sync"
import type { CachedBinding } from "./state"

const log = Log.create({ service: "altimate-workspace-memory-backfill" })

/** What a bind's memory seed concluded. `off` is "never ran" (memory disabled here or
 * for the workspace), `incomplete` is "ran and left blocks behind"; `link` reports the
 * two differently, since only the second needs the user to retry a Sync. */
export type SeedOutcome = {
  status: "seeded" | "already" | "off" | "local-off" | "incomplete"
  sent: number
  pending: number
}

/** Push every non-expired local block. Throttled and resumable inside
 * ``backfill`` — blocks already synced at their current payload are skipped, so
 * repeated binds cost index reads rather than uploads.
 *
 * Covers both scopes: project blocks attach to the workspace just bound, and
 * global blocks go up account-level. A bind is the only moment global memory is
 * swept; blocks written later ride the ordinary per-write mirror. */
export async function seedOnBind(directory: string, binding: CachedBinding): Promise<SeedOutcome> {
  // Off on this machine (ALTIMATE_DISABLE_MEMORY), which is not the workspace's toggle.
  if (!isEnabled()) return { status: "local-off", sent: 0, pending: 0 }
  try {
    // The directory and binding are passed in rather than rediscovered. The
    // `link` subcommand binds from a plain yargs handler with no instance
    // context, so resolving project scope from the ambient instance throws
    // there — silently, because this catch turns it into a log line while the
    // CLI still prints "Linked". Reading project memory was the entire point.
    const blocks = await MemoryStore.listAll({ directory })
    if (blocks.length === 0) return { status: "seeded", sent: 0, pending: 0 }
    const result = await backfill(blocks, binding, directory)
    log.info("workspace memory seeded after bind", result)
    // `gated` also covers a failed enablement lookup; only a confirmed toggle is "off".
    if (result.gated)
      return memoryEnabledCached(binding) === "disabled"
        ? { status: "off", sent: 0, pending: 0 }
        : { status: "incomplete", sent: 0, pending: blocks.length }
    // Only a sweep that stored everything it meant to counts as seeded. A
    // failure here must leave the binding eligible for a retry, or local blocks
    // stay absent from the workspace until a rebind or an unrelated edit.
    // ``declined`` counts too — a block the service explicitly refused (quota,
    // permissions) is still absent from the workspace and the binding should
    // stay unseeded so a later rebind retries it. Without this a partially-
    // rejected backfill left the binding treated as fully seeded. (altimate-
    // harness-bot #1116 comment 3840503346.) ``deferred`` likewise: a block
    // held back because the record set could not be read, or the workspace
    // holds a newer copy, is not in the workspace at this payload either.
    const pending = result.failed + result.declined + result.deferred
    return { status: pending === 0 ? "seeded" : "incomplete", sent: result.ok, pending }
  } catch (err) {
    log.warn("workspace memory backfill after bind failed", { err: String(err) })
    return { status: "incomplete", sent: 0, pending: 0 }
  }
}

export async function backfillOnBind(directory: string, binding: CachedBinding): Promise<boolean> {
  return (await seedOnBind(directory, binding)).status === "seeded"
}
