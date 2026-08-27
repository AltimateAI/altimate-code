// altimate_change - new file
//
// The module's only path to configuration. Every read refreshes first, because
// this file has been bitten three times by a cached read after someone else's
// write, and the writers cannot be enumerated.
import { Config } from "@/config/config"
import { addMcpToConfig, readMcpEntryFromDisk, removeMcpFromConfig, resolveConfigPath } from "@/mcp/config"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { log, syncInternals, projectRoot } from "./engine-seams"
import type { ExistingEntry, LocalMcpConfig } from "./engine-types"

/** Where this project's config lives.
 *
 * Exposed so a caller can resolve it BEFORE a guard rather than inside the
 * write that follows one: `resolveConfigPath` probes up to nine candidate paths
 * on disk, and every one of those awaits sits between the last check and the
 * mutation it is supposed to protect. */
export async function projectConfigPath(): Promise<string> {
  if (syncInternals.projectConfigPath) return syncInternals.projectConfigPath()
  return resolveConfigPath(projectRoot())
}

/** Why a write did not happen. `written` is the ordinary case. */
export type PersistResult = "written" | "disabled"

export async function persist(name: string, cfg: LocalMcpConfig, configPath?: string): Promise<PersistResult> {
  if (syncInternals.persist) return (await syncInternals.persist(name, cfg)) ?? "written"
  configPath = configPath ?? (await resolveConfigPath(projectRoot()))
  // The check travels WITH the write rather than preceding it. `addMcpToConfig`
  // replaces the whole `mcp.<name>` node, so a disable landing after a caller's
  // guard is not merely raced — it is erased, and the post-install check then
  // reads the file WE just wrote and finds nothing to undo. Invisible rather
  // than reverted.
  //
  // It is decided on the same text the write modifies, which is as close as this
  // can be got: a check that reads the file separately from the write has
  // checked a different read. It does NOT make the window vanish — one read and
  // one write to one file is not atomic, and a disable landing between the read
  // and the `write` syscall is still lost. That residual is named on the PR
  // rather than papered over; closing it needs write-then-verify.
  if ((await addMcpToConfig(name, cfg, configPath, { refuseIfDisabled: true })) === null) {
    log.info("refusing to write over an entry that is disabled on disk", { name })
    return "disabled"
  }
  // `Config.get()` is cached per instance, and `addMcpToConfig` is a raw file
  // write that does not touch that cache — so without this, every later
  // `existingEntry()` in this process still sees the pre-write config. That is
  // how a managed entry becomes unrecognisable to `isManagedEntry` later in the
  // same server process, leaving a stale engine attached in an unbound project.
  // The local-config write path in `config.ts` invalidates for the same reason.
  // NOT observable from this module's own tests, and worth saying so rather than
  // leaving a claim the suite silently fails to check: every read here
  // invalidates first, so a missing invalidation on the WRITE side changes
  // nothing we can see. It is here for the other `Config` consumers in the
  // process, which do not invalidate before reading and would otherwise serve a
  // cached config that predates our write.
  await Config.invalidate().catch((err) => {
    log.warn("could not invalidate the config cache after persisting the engine entry", { err: String(err) })
  })
  return "written"
}

/** The module's ONLY path to config, and it is always fresh.
 *
 * `Config.get()` is cached per instance, and this module has now been bitten
 * three times by reading it after someone else wrote: our own `addMcpToConfig`,
 * `MCP.disconnect` writing `enabled: false`, and an IDE rewriting the entry —
 * which never goes through `Config` at all. Two of those defeated a fix from an
 * earlier round.
 *
 * Enumerating the writers is therefore not possible, so freshness is structural
 * at the point of READ rather than remembered at each write site. The cost is
 * real and shared: invalidating drops the per-instance cache for every other
 * `Config` consumer too. That is the price of not having a fourth instance. */
export async function freshConfig(): Promise<{ mcp?: Record<string, ExistingEntry | undefined> }> {
  if (syncInternals.freshConfig) return syncInternals.freshConfig()
  await Config.invalidate().catch((err) => {
    log.warn("could not refresh the config cache", { err: String(err) })
  })
  return (await Config.get()) as { mcp?: Record<string, ExistingEntry | undefined> }
}

/** The entry in the PROJECT config only, not the merged view.
 *
 * `existingEntry()` returns the merged value, which may come from global config,
 * while `persist()` writes to the project file. Restoring the merged value would
 * write a copy of the global entry into the project — a permanent override that
 * shadows every later global update, disable or removal, from an attach that was
 * meant to leave configuration untouched. */
export async function projectEntry(): Promise<ExistingEntry | null> {
  if (syncInternals.projectEntry) return syncInternals.projectEntry()
  // THROWS rather than returning null on a read error, because the two answers
  // mean opposite things to the caller: `null` says "the project file has no
  // entry of its own", and a restore acts on that by REMOVING ours. Conflating
  // "there was nothing here" with "I could not look" turned an unreadable
  // project config into a deletion of the user's own entry. If we cannot record
  // what to put back, we must not write in the first place.
  const configPath = await resolveConfigPath(projectRoot())
  return ((await readMcpEntryFromDisk(DATAMATE_KEY, configPath)) as ExistingEntry | undefined) ?? null
}

/** Put the config back the way we found it.
 *
 * `persist()` commits the pin BEFORE the engine is known to be ours, so a
 * supersede after that point leaves the abandoned workspace pinned on disk —
 * and MCP bootstraps every enabled entry, so a restart before the next attach
 * would start the workspace we just walked away from. Removing the runtime
 * client is only half of undoing an attach. */
export async function persistRestore(
  name: string,
  previous: ExistingEntry | null,
  configPath?: string,
): Promise<"restored" | "failed"> {
  if (syncInternals.persistRestore) return (await syncInternals.persistRestore(name, previous)) ?? "restored"
  try {
    // The SAME path the write used, not a fresh resolution: re-resolving can
    // pick a different file than the one we wrote to, in which case the undo
    // edits a config we never touched and leaves the one we did.
    const target = configPath ?? (await resolveConfigPath(projectRoot()))
    if (previous) await addMcpToConfig(name, previous as never, target)
    else await removeMcpFromConfig(name, target)
    await Config.invalidate().catch(() => undefined)
    return "restored"
  } catch (err) {
    // Reported, not swallowed. An undo that could not be confirmed leaves our
    // pin on disk, and MCP bootstraps every enabled entry — so the next restart
    // starts the workspace this attach walked away from. That is an actionable
    // failure, and the caller can only tell the user about it if it is told.
    log.warn("could not restore the config after a superseded attach", { name, err: String(err) })
    return "failed"
  }
}

export async function existingEntry(name: string): Promise<ExistingEntry | null> {
  if (syncInternals.existingEntry) return syncInternals.existingEntry(name)
  // THROWS rather than returning null, for the same reason `projectEntry` does:
  // `null` already means "there is no entry", and every caller acts on that —
  // the guard reads it as "nothing forbids this write", the inspection plans it
  // as "nothing here, spawn". Swallowing here made the fail-closed guard one
  // layer above UNREACHABLE: the guard's own catch could never fire, because the
  // failure had already been converted into a confident answer beneath it.
  //
  // A rule enforced at one layer and undone at the layer below is not enforced.
  const cfg = await freshConfig()
  return cfg.mcp?.[name] ?? null
}
