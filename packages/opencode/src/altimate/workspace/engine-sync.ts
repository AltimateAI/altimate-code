// altimate_change - new file
//
// Attach the bound workspace's integration engine to an altimate-code session.
//
// Integrations are served by the local datamate engine — the same process the
// VS Code extension spawns as `datamate start-stdio`. altimate-code can reuse an
// entry an IDE already wrote, but until now it could not acquire an engine on
// its own: with no entry present it fell to the hosted SSE endpoint, which runs
// in multi-user mode and serves a DIFFERENT tool set (no connection validation,
// no extension-bridge tools, server-side cwd). This module closes that gap.
//
// Rules, in order:
//  1. Reuse, but only what is ATTRIBUTABLE. An entry already registered under
//     DATAMATE_KEY is reused only when it is live AND its command pins the
//     engine to this workspace (`--datamate <id>`) AND that binary clears the
//     version floor. Being connected proves none of that: an unpinned engine
//     serves whichever teammate its owner has active, and that changes at
//     runtime from a UI this client does not control — the extension writes
//     exactly such an entry. Reusing one would report "workspace X: N tools"
//     about a process serving Y.
//     Anything live but not attributable — unpinned, pinned elsewhere, below the
//     floor, or a URL — is replaced by a pinned local spawn, and what it was is
//     reported. That costs the other client nothing: a stdio entry is a
//     per-client child process, so the IDE keeps its own engine and only our
//     registration changes. A connected URL entry is replaced for the same
//     reason rule 4 exists — the hosted endpoint serves a different tool set.
//     If the entry is DOWN, what it is decides what happens first:
//       - a URL entry is an IDE's in-process engine (normally localhost) or the
//         hosted endpoint. Neither can be revived from here — only the IDE can
//         bring its port back — so with a binding and a usable engine on PATH we
//         spawn locally and say what was replaced. The IDE's own config file is
//         never touched; when the IDE returns, its sync overwrites ours.
//       - a command entry that failed is retried once, then reported. Spawning a
//         second engine beside a failing one is the duplicate-process problem the
//         single-gateway design exists to avoid. A retry that succeeds is then
//         gated for attribution exactly like an entry that never dropped.
//  2. Opportunistic use. If a `datamate` binary is on PATH and its `--version`
//     clears the floor, spawn it for this workspace. A lookup, never an install.
//  3. Offer, never silently install. No engine → tell the user exactly which
//     workspace tools are unavailable and how to install. The CLI ships as a
//     self-contained binary with no Node runtime, so it must not pull one in.
//  4. NEVER fall back to hosted on failure. The local and hosted tool sets
//     diverge in both directions, so a silent fallback would change the
//     workspace's declared contract. A failed engine is reported, not routed
//     around.
//  5. Report what was declared but not delivered. The engine intersects the
//     workspace allowlist with what it managed to build and says nothing about
//     the difference; this module diffs declared keys against the tools that
//     actually arrived and surfaces the gap.
//
// Attaching runs beside the turn, not inside it: `ensure` is started before the
// turn's tools are resolved, and `whenAttached` gives a fresh spawn a bounded
// window to land so the engine's tools make the first tool list rather than
// arriving a turn late. Past the cap the turn proceeds and `tools/list_changed`
// delivers them.
//
// Gated on the workspace pilot flag; inert without a local binding.
import { type CachedBinding } from "./state"
import { DATAMATE_KEY } from "@/altimate/datamate-transport"
import { log, syncInternals, isEnabled } from "./engine-seams"
import {
  attributableEngine,
  clearsFloor,
  commandArgv,
  describeEntry,
  describeMissing,
  describeRefusal,
  engineToolKeys,
  installWouldHelp,
  isUrlEntry,
  pinnedWorkspace,
  ENGINE_BINARY,
  INSTALL_HINT,
  MIN_ENGINE_VERSION,
  type ExistingEntry,
  type LocalMcpConfig,
  type Outcome,
  type Toast,
} from "./engine-types"
import {
  declaredBounded,
  engineVersionOf,
  announceToolsChanged,
  mcp,
  notify,
  resolveBinding,
  versionOf,
  which,
} from "./engine-probes"
import { existingEntry, persist, persistRestore, projectEntry } from "./engine-config"
import { serializeAttach, trackedChainsForTests, attachChains } from "./engine-chain"

// The module's public surface is deliberately unchanged by the split: consumers
// import from `engine-sync` and should not have to know which file a symbol
// moved to.
export {
  attributableEngine,
  clearsFloor,
  compareVersions,
  engineToolKeys,
  installWouldHelp,
  pinnedWorkspace,
  ENGINE_BINARY,
  INSTALL_HINT,
  MIN_ENGINE_VERSION,
  type Declared,
  type ExistingEntry,
  type LocalMcpConfig,
  type Outcome,
} from "./engine-types"
export { isEnabled, syncInternals } from "./engine-seams"
export { trackedChainsForTests } from "./engine-chain"

// ---------------------------------------------------------------------------
// Production implementations behind the seams
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The attach flow
// ---------------------------------------------------------------------------

/** What an existing entry means for this workspace — the whole decision, taken
 * in one synchronous step over one snapshot.
 *
 * The order below is the contract, and it is the part of this module with the
 * worst history: intent outranks connectivity, connectivity outranks
 * attribution, attribution outranks version. Three separate review rounds each
 * found one of those checks sitting on the wrong side of another, and each time
 * the defect was reachable only because an await separated them — a config read,
 * a status call, a version probe. A function that cannot await cannot reorder
 * itself, so those defects stop being possible rather than being fixed again.
 *
 * `retried` is why "one retry, never two" is a property here rather than a
 * branch someone has to remember not to re-enter. */
type EntryPlan =
  | { act: "spawn" }
  | { act: "honour-disable" }
  | { act: "retry-connect" }
  | { act: "refuse-unreachable"; error: string }
  | { act: "replace-unreachable-url"; url: string }
  | { act: "replace-unattributable"; entry: string; pinnedTo: string | null }
  | { act: "check-version" }

export function planForEntry(
  entry: ExistingEntry | null,
  observed: { status: string; error?: string } | undefined,
  workspaceId: string,
  retried: boolean,
): EntryPlan {
  // Nothing registered under this key: there is no entry to judge.
  if (!observed) return { act: "spawn" }

  // Intent first. The config's `enabled` flag is the only place a user
  // expresses "off", and the two sources disagree in BOTH directions:
  // `MCP.status()` synthesizes "disabled" for a configured entry with no
  // runtime status (so a teardown looks like a user disable), and it keeps
  // reporting "connected" from live client state after the config has been set
  // to disabled (so a real disable looked like nothing at all). Gating on
  // connectivity missed the second case entirely.
  if (entry?.enabled === false) return { act: "honour-disable" }

  if (observed.status !== "connected") {
    // A dead URL is not something this client can revive — only the IDE can
    // restore its port — so it is replaced rather than retried.
    if (isUrlEntry(entry)) return { act: "replace-unreachable-url", url: entry.url }
    if (retried) return { act: "refuse-unreachable", error: observed.error ?? observed.status ?? "not connected" }
    return { act: "retry-connect" }
  }

  // Live — either it already was, or the single retry brought it back. A
  // recovered entry is gated exactly like one that never dropped.
  //
  // "Connected" is not attribution. An entry without `--datamate <id>` follows
  // its owner's active teammate, which changes at runtime from a UI this client
  // does not control; reusing one would report "workspace X: N tools" about a
  // process serving Y, and once precedence acts on that inventory it routes the
  // model into another workspace's credentials.
  const pin = pinnedWorkspace(entry)
  if (pin !== workspaceId) {
    return { act: "replace-unattributable", entry: describeEntry(entry), pinnedTo: pin }
  }
  return { act: "check-version" }
}

async function run(): Promise<Outcome> {
  if (!isEnabled()) return { kind: "disabled" }

  const client = mcp()

  const binding = await resolveBinding()
  if (!binding) {
    // An entry left over from a binding that no longer exists still gets started
    // by MCP bootstrap and can serve the OLD workspace's tools here. Tempting to
    // tear it down — but we cannot prove we wrote it. argv shape is not
    // provenance: a hand-authored `datamate start-stdio --datamate <id>` is
    // byte-identical to ours, and removing it would take the user's own server
    // offline on every first prompt. This module's whole thesis is that you do
    // not act on something you cannot attribute, so it applies to itself here:
    // report it and leave it alone. Attributing this properly needs an explicit
    // ownership marker written at persist time, which is a separate change.
    const present = (await client.status())[DATAMATE_KEY]
    if (present) {
      const stale = await existingEntry(DATAMATE_KEY)
      const pin = pinnedWorkspace(stale)
      if (pin) {
        log.info("unbound project has an engine entry pinned to a workspace; leaving it alone", {
          pinnedTo: pin,
          entry: describeEntry(stale),
        })
      }
    }
    return { kind: "unbound" }
  }
  const workspaceId = String(binding.datamateId)

  // Rule 1 — reuse what already serves this session, but only if it can be shown
  // to serve THIS workspace, on an engine that still clears the floor.
  //
  // "Connected" is not that proof. An entry without `--datamate <id>` follows
  // its owner's active teammate, and that changes at runtime from a UI this
  // client does not control — the extension writes exactly such an entry. Reusing
  // one would let us report "workspace X: N tools" about a process serving Y,
  // and once precedence acts on that inventory it would route the model into
  // another workspace's credentials, with no fallback and nothing naming the
  // discrepancy. The floor is re-checked here for the same reason: a stale
  // persisted entry can be running an engine old enough that its pin is not
  // locked, which is the drift this attribution is meant to exclude.
  let replaced: string | undefined
  let replacedNote = ""

  /** Is this attach still the one this project wants?
   *
   * The binding is snapshotted at the top of `run()`, but reaching a mutation
   * costs seconds — a status call, one or two process spawns for `--version`,
   * and the workspace allowlist over the network. A re-link inside that window
   * leaves this attach acting for a workspace the project has already left, and
   * per-project serialization does not help: it orders the writes, so the stale
   * attach simply installs FIRST and the replacement queues behind it. Anything
   * that mutates MCP state re-checks here and abandons instead.
   *
   * Cheap enough to call before every mutation — the binding is a local cache
   * read, not a network one. */
  const stillCurrent = async (): Promise<boolean> => {
    const now = await resolveBinding().catch(() => null)
    return !!now && String(now.datamateId) === workspaceId
  }

  /** Stop serving an entry we have judged untrustworthy for this workspace.
   *
   * Runtime-only (`MCP.remove`): closes the client and drops it from the tool
   * catalogue without touching any config file — `MCP.disconnect` would persist
   * `enabled: false` into whichever config owns the entry, which for a global
   * one disables the user's engine everywhere.
   *
   * This must run at the moment of REJECTION, not merely before a replacement
   * spawn. Every exit that fails to produce a replacement — `engine-missing`,
   * `engine-too-old` — would otherwise return with the rejected engine still
   * connected, and the turn's `resolveTools` would hand the model exactly the
   * tools we just decided it must not have. It also closes the client `MCP.add`
   * would otherwise overwrite without closing, which orphans a second engine. */
  const detachRejected = async (why: Record<string, unknown>): Promise<void> => {
    if (!(await stillCurrent())) {
      log.info("skipping teardown; the binding changed while this attach was deciding", { workspaceId, ...why })
      return
    }
    await client.remove(DATAMATE_KEY).catch((err) => {
      log.warn("could not detach the rejected engine entry", { err: String(err), ...why })
    })
  }
  /** Abandon an install without trace.
   *
   * Both halves, together, because they were fixed one round apart: a supersede
   * that undid only the runtime left our pin on disk, and MCP bootstrap starts
   * every enabled entry — so a restart before the next attach would start the
   * workspace this project had just walked away from. Naming them as one
   * operation is what stops the next caller from remembering only one.
   *
   * `projectBefore` is the PROJECT file's own entry, not the merged view.
   * Restoring the merged value writes a copy of a global entry into the project,
   * which is a permanent override shadowing every later global change — undoing
   * a write is only correct if it restores what that write replaced. */
  const undoInstall = async (projectBefore: ExistingEntry | null): Promise<Outcome> => {
    await client.remove(DATAMATE_KEY).catch((err) => {
      log.warn("could not remove the superseded engine", { err: String(err) })
    })
    await persistRestore(DATAMATE_KEY, projectBefore)
    return { kind: "superseded" }
  }

  /** The single exit for every refusal.
   *
   * Three properties that were previously spread across six branches, each of
   * which had to remember all three:
   *
   * 1. An actionable failure is never silent — the toast is not optional.
   * 2. A refusal that leaves a client registered tears it down. The caller runs
   *    `resolveTools` whatever this returns, so declining while the old client
   *    stays registered hands that turn its tools and its credentials anyway.
   *    The outcome is advice; the registration is what the model sees.
   * 3. Whether a remedy exists is asked in ONE place, of `installWouldHelp`,
   *    with the binding still in scope. "Refused" and "no engine is obtainable"
   *    are different questions, and unifying refusals is exactly what makes them
   *    diverge: a user who deliberately disabled their engine must never be
   *    offered an install for the engine they already have and switched off. */
  const refuse = async (outcome: Outcome, toast: Toast, detach?: Record<string, unknown>): Promise<Outcome> => {
    if (detach) await detachRejected(detach)
    await notify(toast)
    if (installWouldHelp(outcome)) {
      log.info("refusal is remediable by installing the engine", { workspaceId, kind: outcome.kind })
    }
    return outcome
  }

  // Read the entry BEFORE asking for status. `existingEntry` refreshes the config
  // cache and `MCP.status()` reads that same cache — so an entry an IDE or user
  // added after the cache was warmed is missing from status entirely, `existing`
  // is undefined, rule 1 never runs, and we persist our managed entry straight
  // over theirs. Refreshing first is what makes the status gate trustworthy.
  // Intent, then connectivity, then attribution, then version.
  //
  // That order is what this flow kept getting wrong: three separate review
  // rounds each moved one of these checks past another, and every one of those
  // mistakes was possible only because the checks were separated by an await.
  // `planForEntry` cannot await, so none of them is expressible against it.
  //
  // The entry is read BEFORE the status it is judged against. `existingEntry`
  // refreshes the config cache that `MCP.status()` then reads, so an entry an
  // IDE added after the cache warmed would otherwise be missing from status
  // entirely — the entry check would never run and our managed entry would be
  // persisted straight over theirs.
  const entry = await existingEntry(DATAMATE_KEY)
  let observed = (await client.status())[DATAMATE_KEY]
  let plan = planForEntry(entry, observed, workspaceId, false)

  if (plan.act === "retry-connect") {
    // Exactly one retry, then report — never a second spawn beside a failing
    // one. "Never twice" is the `retried` argument rather than a branch someone
    // has to remember not to re-enter.
    await client.connect(DATAMATE_KEY).catch(() => undefined)
    observed = (await client.status())[DATAMATE_KEY]
    plan = planForEntry(entry, observed, workspaceId, true)
  }

  if (plan.act === "honour-disable") {
    // The user turned this entry off deliberately. Do NOT call `MCP.connect` to
    // "retry" it: that persists `enabled: true` into whichever config owns the
    // entry, so for a global `datamate` the first prompt in any bound project
    // would silently re-enable it for every other project.
    //
    // Leaving the CONFIG alone is the point; leaving the RUNTIME alone is not.
    // `MCP.status()` reports live client state and `MCP.tools()` gates on
    // exactly that status, consulting the config only for a timeout — so an
    // entry disabled after it connected keeps exporting its tools and its
    // credentials to the turn. `remove` is runtime-only: it closes the client
    // and publishes ToolsChanged without writing config, which is respecting
    // the edit rather than re-applying it.
    log.info("engine entry is explicitly disabled; leaving it alone", { workspaceId })
    return await refuse(
      { kind: "entry-disabled" },
      {
        title: "Workspace engine is disabled",
        message:
          `The "${DATAMATE_KEY}" MCP entry is disabled, so workspace "${binding.datamateName}" ` +
          `integration tools are unavailable. Enable it to use them.`,
        variant: "warning",
      },
      { reason: "the entry is disabled" },
    )
  }

  if (plan.act === "refuse-unreachable") {
    return await refuse({ kind: "connect-failed", error: plan.error }, {
      title: "Workspace engine is not running",
      message:
        `The "${DATAMATE_KEY}" MCP entry for workspace "${binding.datamateName}" could not connect: ` +
        `${plan.error}. Integration tools are unavailable until it does.`,
      variant: "error",
    })
  }

  if (plan.act === "replace-unreachable-url") {
    // Dead URL: nothing here can bring that process back — only the IDE can
    // restore its port. Fall through to a local spawn and report it below.
    replaced = plan.url
    replacedNote = ` Replaced the unreachable engine URL ${plan.url} for this session.`
    log.info("existing engine entry is a URL that is not reachable; will spawn locally", {
      workspaceId,
      url: plan.url,
      error: observed?.error,
    })
  }

  if (plan.act === "replace-unattributable") {
    // Not attributable to this workspace. Replacing it costs the other client
    // nothing: a stdio entry is a per-client child process, so the IDE keeps its
    // own engine and only OUR registration changes. A connected URL entry lands
    // here too, which is the point — the hosted endpoint serves a different tool
    // set, and rule 4 forbids adopting it.
    replaced = plan.entry
    replacedNote = plan.pinnedTo
      ? ` Replaced an engine entry pinned to workspace ${plan.pinnedTo} for this session.`
      : ` Replaced an engine entry that is not pinned to this workspace (${plan.entry}) for this session; ` +
        `it serves whichever workspace its owner has active.`
    log.info("existing engine entry is not attributable to this workspace; detaching", {
      workspaceId,
      pinnedTo: plan.pinnedTo,
      entry: plan.entry,
    })
    await detachRejected({ workspaceId, reason: "not-attributable", pinnedTo: plan.pinnedTo })
  }

  if (plan.act === "check-version") {
    const found = await engineVersionOf(entry)
    if (clearsFloor(found)) {
      // Rule 5 applies to a reused engine too. A running engine that lost an
      // integration — a connection deleted, a restart that dropped it — serves
      // fewer tools than the workspace declares, and only the fresh attach used
      // to say so. Reuse is the COMMON path, so staying silent here is where the
      // gap would actually go unnoticed.
      const present = engineToolKeys(await client.tools())
      const declaredKeys = await declaredBounded(workspaceId)
      const missing = declaredKeys ? declaredKeys.keys.filter((k) => !present.has(k)) : []
      const available = present.size
      if (declaredKeys && missing.length > 0) {
        await notify({
          title: `Workspace "${binding.datamateName}" is missing declared tools`,
          message:
            `The running engine serves ${available} of ${declaredKeys.keys.length} declared integration tools.` +
            describeMissing(missing),
          variant: "warning",
        })
      }
      // Returning `reused` ASSERTS that the connected engine serves the current
      // binding — and the lookup above can have waited. Every mutation already
      // revalidates; so must this, because the caller acts on the answer just as
      // surely. A re-link inside that await would otherwise hand this turn the
      // previous workspace's tools, and its credentials, under the new binding.
      if (!(await stillCurrent())) {
        // Detach, do not merely decline. The caller runs `resolveTools` whatever
        // this returns, so leaving the old client registered hands that turn the
        // previous workspace's tools and credentials anyway — the outcome is
        // advice, the registration is what the model sees.
        log.info("binding changed while reusing; detaching rather than answering for the old workspace", {
          workspaceId,
        })
        await client.remove(DATAMATE_KEY).catch((err) => {
          log.warn("could not detach the superseded engine", { err: String(err) })
        })
        return { kind: "superseded" }
      }
      log.info("reusing existing engine entry", {
        workspaceId,
        available,
        version: found,
        declared: declaredKeys?.keys.length,
        missing,
      })
      return {
        kind: "reused",
        available,
        ...(declaredKeys ? { declared: declaredKeys.keys.length, missing } : {}),
      }
    }

    // Pinned to us, but below the floor or unreadable. Prefer a newer engine on
    // PATH over keeping one whose pin the engine does not lock; if PATH cannot
    // do better, say so rather than reuse it silently.
    //
    // PATH is probed HERE rather than inside the plan because probing spawns a
    // process: folding it into the pure decision would charge the reuse path —
    // the common one, run on every turn — for a question it never asks.
    const onPath = which(ENGINE_BINARY)
    const pathVersion = onPath ? await versionOf(onPath) : null
    if (!clearsFloor(pathVersion)) {
      const label = found ?? "unknown"
      // Rejected and irreplaceable: detach anyway. Leaving it connected would
      // return "too old" while still serving the too-old engine's tools.
      return await refuse(
        { kind: "engine-too-old", found: label },
        {
          title: found ? "Workspace engine is too old" : "Workspace engine is not runnable",
          message: describeRefusal(found, binding.datamateName),
          variant: "warning",
        },
        { workspaceId, reason: "below-floor", found: label },
      )
    }
    replaced = describeEntry(entry)
    replacedNote = ` Replaced an engine entry running ${found ?? "an unreadable version"}, below the ${MIN_ENGINE_VERSION} floor, for this session.`
    log.info("existing engine entry is below the version floor; detaching", {
      workspaceId,
      found,
      pathVersion,
    })
    await detachRejected({ workspaceId, reason: "below-floor-replaceable", found })
  }

  // Bounded: this lookup is reporting only, but it runs BEFORE the engine is
  // launched and its HTTP layer has no abort timeout — so an API that accepts a
  // connection and then stalls stopped a good cached binding and an installed
  // engine from ever attaching. Reporting degrades; attaching does not wait.
  const declaredKeys = await declaredBounded(workspaceId)
  const declaredCount = declaredKeys?.keys.length ?? 0

  // Rule 2 / 3 — opportunistic use, or an offer. Never an install.
  const bin = which(ENGINE_BINARY)
  if (!bin) {
    return await refuse({ kind: "engine-missing", declared: declaredCount }, {
      title: "Workspace integrations unavailable",
      message:
        `Workspace "${binding.datamateName}" declares ${declaredCount} integration tool${declaredCount === 1 ? "" : "s"}. ` +
        `They run on the local engine, which is not installed. Install it with: ${INSTALL_HINT}`,
      variant: "warning",
    })
  }

  const found = await versionOf(bin)
  if (!clearsFloor(found)) {
    const label = found ?? "unknown"
    return await refuse({ kind: "engine-too-old", found: label }, {
      title: found ? "Workspace engine is too old" : "Workspace engine is not runnable",
      message: describeRefusal(found, binding.datamateName),
      variant: "warning",
    })
  }

  // Spawn under the same server key the IDE uses, bound to THIS workspace.
  // `--datamate` is pinned engine-side so the settings watcher cannot swap it.
  const cfg: LocalMcpConfig = {
    type: "local",
    command: [ENGINE_BINARY, "start-stdio", "--datamate", workspaceId],
    enabled: true,
  }
  // Snapshot what persist() is about to overwrite — the project file's own
  // entry, not the merged view — so a supersede can put back exactly that.
  //
  // Read BEFORE the guard rather than between it and the writes. Every await
  // after the last check reopens the window that check exists to close, and a
  // disk read is a wide one. The post-install guard would undo the stale attach,
  // but only after it had spawned an engine and held the per-project lock — long
  // enough for the replacement's first-turn wait to expire, which is the failure
  // the guard was added to prevent. Nothing may await between the guard and the
  // mutations it guards.
  const projectBefore = await projectEntry()
  if (!(await stillCurrent())) {
    // Re-linked while we were probing. Installing now would attach the workspace
    // this session has already left, and would win by arriving first.
    log.info("abandoning attach; the binding changed before the engine was installed", { workspaceId })
    return { kind: "superseded" }
  }
  await persist(DATAMATE_KEY, cfg)
  await client.add(DATAMATE_KEY, cfg)

  // Rule 4 — a failed local engine is reported, never routed around.
  const after = (await client.status())[DATAMATE_KEY]
  if (after?.status !== "connected") {
    const error = after?.error ?? after?.status ?? "not connected"
    return await refuse({ kind: "connect-failed", error }, {
      title: "Workspace engine failed to start",
      message: `Could not start ${ENGINE_BINARY} for workspace "${binding.datamateName}": ${error}. Integration tools are unavailable; not falling back to the hosted endpoint because it serves a different tool set.`,
      variant: "error",
    })
  }

  // Rule 5 — report declared-but-missing.
  const present = engineToolKeys(await client.tools())
  const missing = declaredKeys ? declaredKeys.keys.filter((k) => !present.has(k)) : []
  const available = present.size
  // ONE guard, placed after every await that follows the install — the handshake
  // AND the tool listing. Both are windows in which a re-link can land, and the
  // earlier version guarded only the first, so a flip during the tool read left
  // the previous workspace installed and reported as attached.
  //
  // Late rather than early on purpose: the check is only meaningful at the last
  // moment before we announce and answer, because everything before that is
  // still revocable.
  if (!(await stillCurrent())) {
    log.info("binding changed before the attach could be reported; undoing what we installed", { workspaceId })
    return await undoInstall(projectBefore)
  }

  // Ours, and staying: announce it so a turn that had already given up waiting
  // still learns the tools arrived.
  await announceToolsChanged()

  await notify({
    title: `Workspace "${binding.datamateName}" connected`,
    message:
      (declaredKeys
        ? `${available} of ${declaredCount} declared integration tools available.`
        : `${available} integration tools available.`) +
      describeMissing(missing) +
      replacedNote,
    variant: missing.length > 0 ? "warning" : "success",
  })
  log.info("attached workspace engine", { workspaceId, available, declared: declaredCount, missing, replaced })
  return { kind: "attached", available, declared: declaredCount, missing, ...(replaced ? { replaced } : {}) }
}

// ---------------------------------------------------------------------------
// Public entry — idempotent per session, never throws. `ensure` never blocks a
// turn; `whenAttached` is the one bounded wait, and only turn 1 pays it.
// ---------------------------------------------------------------------------

/** How long a turn may wait for a fresh attach before proceeding without it.
 *
 * A cold attach measured ~6.5s on a warm machine — ~1s to probe `--version`,
 * ~1s for the workspace's declared allowlist, and ~4.5s for the engine to boot,
 * handshake, and build its tools — and crossed 8s under the load of a real
 * turn. The cap is set well clear of that so the common case lands inside it,
 * and still far below MCP's own 30s connect timeout so an engine that never
 * answers costs the first turn a pause rather than the turn itself. */
export const ATTACH_WAIT_MS = 15_000

type SessionAttach = {
  key?: string
  task: Promise<Outcome>
  waitTimedOut?: boolean
  outcome?: Outcome
  /** The entry argv whose version we last verified against the floor. */
  validated?: string
}

/** Outcomes the user can repair without restarting: install the engine, update
 * it, fix a broken entry. Caching these for the life of the session means the
 * hint we just printed ("install it with …") can be followed and nothing
 * happens until a new session — so they are re-probed on the next turn. */
const REPAIRABLE = new Set<Outcome["kind"]>([
  "engine-missing",
  "engine-too-old",
  "connect-failed",
  "entry-disabled",
  "superseded",
])

function isRepairable(outcome: Outcome | undefined): boolean {
  return !!outcome && REPAIRABLE.has(outcome.kind)
}

/** Did this outcome leave an engine serving this session? */
function wasServing(outcome: Outcome | undefined): boolean {
  return attributableEngine(outcome)
}

/** Is the engine we attached still connected?
 *
 * A memoised success is only true while it stays true. When the engine's child
 * exits, MCP drops the client and marks the entry `failed`, but a settled
 * successful outcome was returned before `run()` ever read that status — so
 * every later turn resolved without the integration tools and nothing
 * reconnected until a new session or a re-link.
 *
 * Fails OPEN: a status read that throws must not invalidate a good attach. */
async function engineStillOurs(workspaceId: string, record?: SessionAttach): Promise<boolean> {
  try {
    if ((await mcp().status())[DATAMATE_KEY]?.status !== "connected") return false
    // Connected is not enough. Link A -> B -> A with another session attaching B
    // in between, and this session's key matches its original memo while the
    // instance-wide client is serving B — so the cached success would expose B's
    // tools under binding A. The pin is what makes it ours.
    const entry = await existingEntry(DATAMATE_KEY)
    // Intent outranks every other check, and it is checked FIRST because the
    // command-unchanged shortcut below returns early: a session that already
    // attached would otherwise ride its memo straight past the disable for the
    // rest of its life, never re-entering `run()` where the check lives.
    // Returning false here does not itself detach — it routes this session back
    // through `run()`, which reports `entry-disabled` and tears the client down.
    if (entry?.enabled === false) {
      log.info("engine entry was disabled since the cached attach; re-deciding", { workspaceId })
      return false
    }
    if (pinnedWorkspace(entry) !== workspaceId) return false

    // The pin is not the whole contract: the FLOOR is what makes the pin
    // trustworthy, since engines below it do not lock it. An entry reconnected
    // or replaced behind the same pin with a pre-floor binary would otherwise
    // ride the cached success forever, never passing through `run()` again.
    //
    // Re-probed only when the command CHANGES, because probing spawns a process
    // and this runs every turn. The residual is narrow and worth naming: a
    // binary swapped in place under an unchanged command is not caught until the
    // next session.
    const command = commandArgv(entry).join(" ")
    if (record && record.validated === command) return true
    // Same probe and same floor as the attach path, from the same helpers. This
    // was duplicated here, which is how a describer and a decider drift apart.
    const found = await engineVersionOf(entry)
    if (!clearsFloor(found)) {
      log.info("cached attach no longer clears the version floor; re-attaching", { workspaceId, found })
      return false
    }
    // Recorded on the CURRENT entry — the one that will be remembered and copied
    // forward. Writing it to the previous entry would be discarded next turn.
    if (record) record.validated = command
    return true
  } catch (err) {
    log.warn("could not re-probe the engine attribution; keeping the cached attach", { err: String(err) })
    return true
  }
}

/** Cap on remembered sessions.
 *
 * These maps are module-level and a long-running `serve` process creates
 * sessions indefinitely, so without a bound they grow for the life of the
 * process. Evicting the oldest is safe: a session whose memo is dropped simply
 * re-attaches on its next turn, which is correct, just not free. */
export const MAX_TRACKED_SESSIONS = 256

const sessions = new Map<string, SessionAttach>()

/** Insertion-ordered eviction — `Map` preserves insertion order, so the first
 * key is the least recently STARTED attach. */
function rememberSession(sessionID: string, entry: SessionAttach): void {
  sessions.delete(sessionID)
  sessions.set(sessionID, entry)
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next()
    if (oldest.done) break
    sessions.delete(oldest.value)
  }
}

/** Test seam — how many sessions are currently remembered. */
export function trackedSessionsForTests(): number {
  return sessions.size
}

/** What a memoised attach is valid FOR.
 *
 * Memoising on the session id alone was wrong: the binding can change while a
 * session is open — `recordApprovedBinding` is reachable mid-session from the
 * TUI workspace panel as well as from `altimate-code link`. A session that
 * started unbound would then never attach, and one that was re-linked to another
 * workspace would keep serving the old workspace's tools, both silently and for
 * the rest of the session. Keying on the bound workspace makes a re-link produce
 * a fresh attach on the next turn and leaves everything else memoised as before. */
/** The bound workspace id, or null when unbound or disabled. */
async function attachKeyWorkspace(): Promise<string | null> {
  if (!isEnabled()) return null
  const binding = await resolveBinding()
  return binding ? String(binding.datamateId) : null
}

async function attachKey(): Promise<string> {
  if (!isEnabled()) return "disabled"
  const binding = await resolveBinding()
  return binding ? `workspace:${binding.datamateId}` : "unbound"
}

export function ensure(sessionID: string): Promise<Outcome> {
  // NOT async, and the entry is registered SYNCHRONOUSLY. `whenAttached` is
  // called on the line after this one and looks the session up by id; if the
  // registration happened after an await, that lookup would find nothing and the
  // turn would sail past without waiting — which is exactly the first-turn gap
  // this module exists to close. All the async work happens inside the task.
  const previous = sessions.get(sessionID)
  // Decided SYNCHRONOUSLY, because the entry is published synchronously and
  // `whenAttached` reads it on the very next line. Whether this is a repair
  // retry depends only on the previous outcome, which is already known — the
  // workspace comparison needs an await, and refining the flag after that await
  // is too late: the timer is armed by then, so a hung retry charged the turn
  // the full cap despite the retry being documented as non-blocking.
  //
  // Conservative in the right direction: if the binding also changed, the branch
  // below resets this to false and that fresh attach may lose its wait for one
  // turn. Failing to wait costs a turn's tools, which `tools/list_changed`
  // repairs; waiting wrongly costs every turn 15 seconds.
  const repairRetry = !!previous && isRepairable(previous.outcome)
  const entry = {
    key: previous?.key,
    waitTimedOut: previous?.waitTimedOut || repairRetry,
    // Carried forward, or the version re-probe spawns a process every turn: a
    // fresh entry is built per call, so state that is not copied is state that
    // is silently rebuilt.
    validated: previous?.validated,
  } as SessionAttach
  entry.task = (async (): Promise<Outcome> => {
    const key = await attachKey()
    const sameWorkspace = !!previous && previous.key === key
    // Same workspace and the attach either succeeded or is still in flight:
    // reuse it. A settled FAILURE is not reused — the user may have acted on
    // the hint it produced.
    if (sameWorkspace && !isRepairable(previous!.outcome)) {
      // Re-probe before trusting a cached success — see `engineStillConnected`.
      const boundTo = await attachKeyWorkspace()
      const reusable =
        !wasServing(previous!.outcome) || !boundTo || (await engineStillOurs(boundTo, entry))
      // Validating the cached success is itself awaited work — status, config and
      // possibly a version probe — so the binding can move underneath it. This
      // path lives outside `run()` and therefore never had its final check;
      // without one, a confirmed-valid engine for the workspace we just left is
      // returned as the answer for the one we just joined.
      if (reusable && (await attachKeyWorkspace()) === boundTo) return previous!.task
      log.info("cached attach is no longer connected; re-attaching", { sessionID })
    }
    entry.key = key
    if (sameWorkspace) {
      // Re-probing a repairable failure. Do NOT re-arm the wait: this runs on
      // every turn, and a retry that blocks would charge each one the full cap
      // (a `connect-failed` retry can sit in MCP's 30s connect budget). The
      // repaired engine's tools arrive over `tools/list_changed` instead.
      entry.waitTimedOut = true
    } else {
      // The binding changed under this session. A fresh attach gets a fresh wait
      // budget — the previous one was spent on a different workspace's engine.
      entry.waitTimedOut = false
      // Serialize against the attach being superseded. Both tasks end in
      // `MCP.add`, and whichever completes LAST owns the runtime client, so a
      // slower attach for the workspace we just left could otherwise land after
      // this one and restore its tools — with this session's memo already
      // settled, so no later turn would repair it.
      if (previous) await previous.task.catch(() => {})
    }
    return attachOnce(sessionID)
  })()
  entry.task.then(
    (outcome) => {
      entry.outcome = outcome
    },
    () => {},
  )
  rememberSession(sessionID, entry)
  return entry.task
}

/** One attach, serialized against every other attach in this project, with the
 * outcome logged exactly once. */
function attachOnce(sessionID: string): Promise<Outcome> {
  return serializeAttach(() => run())
    .catch(async (err): Promise<Outcome> => {
      const error = String(err)
      // Every explicit failure branch tells the user what is unavailable and
      // why. An unexpected throw — an unwritable project config, a malformed
      // one — must not be the single path that leaves them with neither tools
      // nor an explanation, since the caller discards this outcome and
      // `whenAttached` returns void.
      log.warn("workspace engine attach failed", { err: error })
      await notify({
        title: "Workspace engine attach failed",
        message: `Could not attach the workspace engine: ${error}. Integration tools are unavailable for this session.`,
        variant: "error",
      })
      return { kind: "connect-failed", error }
    })
    .then((outcome) => {
      // One line per session, whatever happened — silence is the defect this
      // module exists to remove, so it must not be silent about itself.
      log.info("workspace engine outcome", { sessionID, ...outcome })
      return outcome
    })
}

/** The memoised outcome for a session, if its attach has already settled.
 *
 * A pure read: it creates no task, registers nothing, awaits nothing, and does
 * not touch the memo or the project chain. `ensure()` is deliberately unsuitable
 * for this — it builds a fresh task per call and awaits the binding before
 * resolving, so a caller polling it would never see an already-settled promise
 * AND would re-register the session entry once per turn, mutating bookkeeping it
 * only meant to read. Worse, awaiting it is unbounded, which reintroduces the
 * prompt hang the bounded `whenAttached` exists to prevent.
 *
 * Returns undefined while an attach is still in flight, and for a session that
 * has never attached. Callers must treat undefined as "not known yet", never as
 * "no engine". */
export function settledOutcome(sessionID: string): Outcome | undefined {
  return sessions.get(sessionID)?.outcome
}

/** Wait for a session's in-flight attach, capped.
 *
 * A turn resolves its tool list up front, before the per-turn block that starts
 * the attach runs. A session that spawns its own engine therefore listed the
 * engine's tools one turn late — the model saw `datamate_manager` alone on turn
 * 1 and the integration tools only from turn 2. The caller starts `ensure`
 * ahead of tool resolution and waits here to close that gap.
 *
 * Only a turn that actually spawns pays for it: `disabled` and `unbound` settle
 * with no I/O beyond a local cache read, and a reused entry settles as fast as
 * the status call it already makes. On timeout the turn proceeds without the
 * engine's tools and `tools/list_changed` delivers them when the attach lands. */
export async function whenAttached(sessionID: string, timeoutMs: number = ATTACH_WAIT_MS): Promise<void> {
  const state = sessions.get(sessionID)
  if (!state) return
  // A wait that already blew its budget must not be paid again: the caller's
  // block runs on every user turn, and a hung engine keeps this promise pending
  // for MCP's full connect timeout, so every later turn would pay the cap too.
  if (state.waitTimedOut) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    await Promise.race([
      state.task,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (timedOut) {
      state.waitTimedOut = true
      log.info("workspace engine attach did not land in time for this turn", { sessionID, timeoutMs })
    }
  }
}

/** Test seam — drop memoised outcomes. */
export function resetForTests(): void {
  sessions.clear()
  attachChains.clear()
}
