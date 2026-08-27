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
import { existingEntry, persist, persistRestore, projectConfigPath, projectEntry } from "./engine-config"
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

export type Inspection = {
  entry: ExistingEntry | null
  observed: { status: string; error?: string } | undefined
  /** What MCP actually spawned under this key, when it knows.
   *
   * The config says what SHOULD run; this says what IS running, and they
   * diverge whenever the file is rewritten after a client started — another
   * process re-pinning a shared config, an IDE replacing the entry through
   * `MCP.add`, a re-link. Judging attribution on the config alone let this
   * module agree with itself while the live client served another workspace's
   * data under this workspace's name. */
  runtime?: ExistingEntry | undefined
}

/** Config and runtime, read together, in the one correct order.
 *
 * The order is not incidental: `existingEntry` refreshes the config cache that
 * `MCP.status()` then reads, so reading status first means judging this entry
 * against a config that predates it — which is how an entry an IDE had just
 * added went missing from status entirely and our own was persisted over it.
 *
 * They travel as one value because the decision needs BOTH and they must
 * describe the same moment. Passing them as two arguments left it to each
 * caller to pair them correctly, and "the caller remembers" is the property
 * this whole rewrite is trying to stop relying on. */
async function inspectEntry(): Promise<Inspection> {
  const entry = await existingEntry(DATAMATE_KEY)
  const client = mcp()
  const observed = (await client.status())[DATAMATE_KEY]
  const runtime = client.spawned ? await client.spawned(DATAMATE_KEY).catch(() => undefined) : undefined
  return { entry, observed, runtime }
}

export function planForEntry(inspection: Inspection, workspaceId: string, retried: boolean): EntryPlan {
  const { entry, observed } = inspection

  // 1. INTENT. Outranks everything, including whether anything is observed at
  // all. `{ "datamate": { "enabled": false } }` with no `type` is the upstream
  // idiom for switching an entry off, and the only durable way to disable an
  // IDE-discovered one from this config — and `isMcpConfigured` requires a
  // `type`, so MCP omits it from status entirely. Checking intent below the
  // no-observation branch meant that marker reached the spawn path and was
  // overwritten with our own pinned `enabled: true`. "Intent outranks
  // connectivity" was too weak: absence of runtime is not connectivity.
  if (entry?.enabled === false) return { act: "honour-disable" }

  // 2. Nothing is registered under this key, so there is nothing to attribute
  // and nothing to revive. Note this is BELOW intent and above everything else:
  // a disable marker must be honoured even when it is invisible to status, but
  // once intent is settled, absence really does mean there is nothing here.
  if (!observed) return { act: "spawn" }

  // 3. ATTRIBUTION, before connectivity — whose engine is this, not how is it
  // doing. Nursing an engine back to health before asking whose it is has no
  // defensible reading: at best it is work spent on another client's process,
  // at worst it revives the very engine we rejected last turn and then rejects
  // it again. It also wedges: an entry pinned elsewhere that is also DOWN was
  // retried every turn and never replaced, because the retry answered before
  // the pin was ever consulted, so the project sat on `connect-failed` until
  // someone edited config by hand.
  //
  // The previous order — connectivity first — was an artifact rather than a
  // decision: the pin check lived inside an `if (connected)` block, and
  // extracting this function faithfully carried that accident along with the
  // intent, which made it look deliberate.
  const pin = pinnedWorkspace(entry)
  // Attribution is a claim about the RUNNING engine, so the running engine gets
  // a vote. A config entry that names this workspace while MCP is serving a
  // process started from a different one is the silent case: every check agrees,
  // and the tools, and the credentials, belong to somewhere else.
  const runtimePin = inspection.runtime ? pinnedWorkspace(inspection.runtime) : null
  if (inspection.runtime && runtimePin !== workspaceId) {
    return {
      act: "replace-unattributable",
      entry: describeEntry(inspection.runtime),
      pinnedTo: runtimePin,
    }
  }
  if (pin !== workspaceId) {
    // A URL entry pins nothing, so it lands here too — which is the point:
    // the hosted endpoint serves a different tool set and rule 4 forbids
    // adopting it. An unreachable one keeps its own message because that names
    // the port the user's IDE is not serving.
    if (isUrlEntry(entry) && observed.status !== "connected") {
      return { act: "replace-unreachable-url", url: entry.url }
    }
    return { act: "replace-unattributable", entry: describeEntry(entry), pinnedTo: pin }
  }

  // 4. CONNECTIVITY. Reached only for an entry that IS ours, which is the only
  // kind worth reviving.
  if (observed.status !== "connected") {
    if (retried) {
      return { act: "refuse-unreachable", error: observed.error ?? observed.status ?? "not connected" }
    }
    return { act: "retry-connect" }
  }

  // 5. VERSION.
  return { act: "check-version" }
}

/** Tell the user about a refusal — exactly once, from one place.
 *
 * This is a whole function for what is currently one call because it is a
 * substitution point, and the substitution is easy to get wrong in a way no
 * test on either side would catch.
 *
 * `installWouldHelp` names the refusals an install would actually fix. Those
 * belong to an install offer when one exists, and the offer owns the MESSAGING
 * for them: it replaces this toast rather than joining it, and falls back to
 * this same toast whenever it cannot reach a surface. So "an actionable failure
 * is never silent" holds either way, and neither path emits twice.
 *
 * The toast and the offer are alternatives, not a sequence. A refusal that
 * raises both is the double signal — a dialog and a toast saying the same thing
 * — and it would pass a suite asserting a toast fires alongside one asserting an
 * offer is raised, because neither asserts the user sees exactly ONE thing.
 * Replace this function's body; do not add beside it.
 *
 * Module-level so the unexpected-throw path uses it too. That path had grown its
 * own toast — a second place a refusal reaches the user, which is exactly the
 * kind of site an offer would double up on, and the kind nobody writes a fixture
 * for.
 *
 * NEVER throws: "never silent" also has to mean "never relabelled". A throw here
 * reached the catch-all and turned a decided outcome into `connect-failed` with
 * a second toast, so failing to DESCRIBE a verdict silently rewrote it. */
async function announceRefusal(outcome: Outcome, toast: Toast, context?: Record<string, unknown>): Promise<void> {
  try {
    if (installWouldHelp(outcome)) {
      log.info("refusal is remediable by installing the engine", { ...context, kind: outcome.kind })
    }
    await notify(toast)
  } catch (err) {
    log.warn("could not announce the refusal; the outcome stands", {
      ...context,
      kind: outcome.kind,
      err: String(err),
    })
  }
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

  /** Is the world this decision was made in still the world we are mutating?
   *
   * `stillCurrent` asks only about the binding, and a mutation guarded on half
   * the world is guarded on none of it: the plan is held across a version probe,
   * a PATH probe, the workspace allowlist and a disk read — seconds — and a
   * disable landing anywhere in there was then overwritten by our own pinned
   * `enabled: true`. `addMcpToConfig` replaces the whole entry node, so a
   * project-level disable is destroyed outright and a global one is shadowed by
   * the override, after which the memo reads OUR entry and stands forever.
   *
   * Both reads live in one function so nothing can be inserted between them, and
   * this is the LAST await before any mutation. The invariant is not "no
   * mutation on a stale binding" but "no mutation on a stale world". */
  const worldUnchanged = async (): Promise<boolean> => {
    const entryNow = await existingEntry(DATAMATE_KEY).catch(() => null)
    if (entryNow?.enabled === false) {
      log.info("intent changed while deciding; not writing over a disable", { workspaceId })
      return false
    }
    return await stillCurrent()
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
  const detachRejected = async (why: Record<string, unknown>, bindingDependent = true): Promise<void> => {
    // The guard exists to stop us destroying something that may legitimately
    // belong to the NEW binding. That applies to exactly one of the three
    // reasons we tear down, and gating all of them on it left a disabled or a
    // too-old client serving for the turn whenever a re-link raced the decision.
    //
    // Binding-INDEPENDENT, so never gated:
    //   - a disabled entry serves nothing. `enabled: false` is a property of the
    //     entry, not of a workspace, so no re-link makes it servable.
    //   - an engine below the floor serves nobody correctly. The floor is not
    //     workspace-specific either.
    //   - anything THIS attach started. It exists only because we made it, so
    //     leaving it is a leak whatever is bound now.
    //
    // Binding-DEPENDENT, and the only case the guard is for:
    //   - a pre-existing entry we did not create and judged unattributable. If
    //     the binding moved, that entry may be exactly what the new one wants.
    if (bindingDependent && !(await stillCurrent())) {
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
  const refuse = async (
    outcome: Outcome,
    toast: Toast,
    detach?: Record<string, unknown>,
    bindingDependent = true,
  ): Promise<Outcome> => {
    // Teardown BEFORE the announcement, and this order is load-bearing rather
    // than incidental: the announcement is a substitution point, and a body that
    // waits on a person would hold a rejected client connected until they
    // clicked. Stop serving first, explain second.
    if (detach) await detachRejected(detach, bindingDependent)
    // Revalidate before answering — round 13's rule, which covered two of seven
    // answers because only `reused` and `attached` applied it. A refusal is an
    // answer too: a re-link during the config read produced `engine-missing` for
    // the workspace the project had just left, and a toast naming it.
    if (!(await stillCurrent())) {
      log.info("binding changed before this refusal could be reported; not answering for the old workspace", {
        workspaceId,
        kind: outcome.kind,
      })
      return { kind: "superseded" }
    }
    await announceRefusal(outcome, toast, { workspaceId })
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
  let inspection = await inspectEntry()
  let plan = planForEntry(inspection, workspaceId, false)

  if (plan.act === "retry-connect") {
    // Exactly one retry, then report — never a second spawn beside a failing
    // one. "Never twice" is the `retried` argument rather than a branch someone
    // has to remember not to re-enter.
    //
    // NOT `MCP.connect`, which is the wrong primitive three times over. It
    // writes `enabled: true` into whichever config owns the entry — a global
    // one for an IDE-written entry — so a disable landing in its window is
    // destroyed on disk and nothing ever repairs it, because the next read says
    // enabled. It resolves what to spawn from MCP's own retained state rather
    // than from the entry this decision examined, so it can revive the engine
    // we rejected last turn, or start a workspace we have already left. And it
    // is a mutation, so it belongs behind the same guard as every other one.
    //
    // `add` is none of those: it writes no config and starts exactly what it is
    // handed. Reviving becomes the same operation as spawning, which is the
    // real win — the retry stops being a special path with special rules.
    const revive: LocalMcpConfig = { type: "local", command: commandArgv(inspection.entry), enabled: true }
    if (!(await stillCurrent())) return { kind: "superseded" }
    await client.add(DATAMATE_KEY, revive).catch((err) => {
      log.warn("could not restart the engine entry", { err: String(err), workspaceId })
    })
    // Re-inspected whole rather than re-reading status alone: the world may
    // have moved in both halves while we were starting a process.
    inspection = await inspectEntry()
    plan = planForEntry(inspection, workspaceId, true)
  }
  const entry = inspection.entry

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
      false,
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
      error: inspection.observed?.error,
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
        false,
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
  // Everything readable is read HERE, above the guard. `persist` otherwise
  // probes up to nine candidate config paths on disk between the check and the
  // write it protects — round 19's defect one call deeper than round 19 looked.
  // If we cannot record what to put back, we do not write. An unreadable
  // project config previously read as "no entry here", which a later restore
  // acts on by REMOVING — so a transient read failure could delete the user's
  // own entry as the undo of an attach that was meant to leave it alone.
  let projectBefore: ExistingEntry | null
  try {
    projectBefore = await projectEntry()
  } catch (err) {
    return await refuse({ kind: "connect-failed", error: `project config unreadable: ${String(err)}` }, {
      title: "Workspace engine not attached",
      message:
        `Could not read this project's configuration, so the engine was not installed — attaching without being ` +
        `able to undo it risks overwriting your own "${DATAMATE_KEY}" entry. Integration tools are unavailable ` +
        `until the config file can be read.`,
      variant: "error",
    })
  }
  const configPath = await projectConfigPath().catch(() => undefined)
  if (!(await worldUnchanged())) {
    // Re-linked or disabled while we were probing. Installing now would attach a
    // workspace this session has left, or overwrite a disable that landed while
    // we were deciding — and would win by arriving first.
    log.info("abandoning attach; the world changed before the engine was installed", { workspaceId })
    return { kind: "superseded" }
  }

  // ---- the install region ------------------------------------------------
  //
  // Past the next two lines this attach OWNS two things: a pinned entry on disk
  // and a registered runtime client. Every exit that is not `attached` has to
  // give both back — including an exit nobody wrote.
  //
  // Three separate defects lived in this region because each exit remembered
  // the undo separately. The post-install `connect-failed` return had no undo
  // at all, so a failing engine left our pin on disk and the user's own project
  // entry gone; because a failing pin is retried rather than replaced, the
  // project then wedged on `connect-failed` until someone edited config by
  // hand. A throw from the status or tool read — a malformed config written
  // concurrently by an IDE is enough — unwound straight past every undo with
  // the engine registered, connected and persisted. And the supersede guard's
  // undo was correct but was the only one.
  //
  // `committed` rather than a bare `finally` because the attached path must not
  // undo itself. One rule, one place, and exits nobody anticipated are covered
  // by construction rather than by review.
  let committed = false
  try {
    await persist(DATAMATE_KEY, cfg, configPath)
    await client.add(DATAMATE_KEY, cfg)

    // Rule 4 — a failed local engine is reported, never routed around.
    const after = (await client.status())[DATAMATE_KEY]
    if (after?.status !== "connected") {
      const error = after?.error ?? after?.status ?? "not connected"
      // `which` rather than the error string: "the engine failed to start" and
      // "there is no engine" are different situations with different remedies,
      // and only the second is fixed by installing one. Reading ENOENT out of a
      // message would be re-deriving from a platform detail what a PATH lookup
      // answers directly.
      if (!which(ENGINE_BINARY)) {
        return await refuse({ kind: "engine-missing", declared: declaredCount }, {
          title: "Workspace integrations unavailable",
          message:
            `Workspace "${binding.datamateName}" declares ${declaredCount} integration tool${declaredCount === 1 ? "" : "s"}. ` +
            `They run on the local engine, which is not installed. Install it with: ${INSTALL_HINT}`,
          variant: "warning",
        })
      }
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
    // ONE guard, placed after every await that follows the install — the
    // handshake AND the tool listing. Both are windows in which a re-link can
    // land, and an earlier version guarded only the first, so a flip during the
    // tool read left the previous workspace installed and reported as attached.
    //
    // Late rather than early on purpose: the check is only meaningful at the
    // last moment before we announce and answer, because everything before that
    // is still revocable. The undo itself now belongs to the region.
    if (!(await worldUnchanged())) {
      log.info("the world changed before the attach could be reported; undoing what we installed", { workspaceId })
      return { kind: "superseded" }
    }

    // Ours, and staying. Answer BEFORE announcing: `announceToolsChanged` and
    // the toast are two more awaits, and the outcome asserts which workspace is
    // served — round 13's rule, which the announces quietly put back at risk.
    committed = true
    const outcome: Outcome = {
      kind: "attached",
      available,
      declared: declaredCount,
      missing,
      ...(replaced ? { replaced } : {}),
    }
    log.info("attached workspace engine", { workspaceId, available, declared: declaredCount, missing, replaced })

    // Announce it so a turn that had already given up waiting still learns the
    // tools arrived.
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
    return outcome
  } finally {
    if (!committed) {
      await undoInstall(projectBefore).catch((err) => {
        log.warn("could not undo a non-attached install", { err: String(err), workspaceId })
      })
    }
  }
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

/** Is the memoised success still true?
 *
 * Validated by the SAME reader and the SAME decision as a fresh attach, because
 * this was a second copy of the intent/attribution/floor logic in a different
 * order — it read status before config, the reverse of what the reader
 * documents — and it is the common path, taken on every turn after the first.
 * A second implementation of a decision is a second place for the decision to
 * be wrong, and this one was: it never consulted intent at all, so a memo
 * outlived a disable for the life of the session.
 *
 * "Still valid" is defined as the plan saying reuse. Nothing else.
 *
 * Fails OPEN: a read that throws must not invalidate a good attach. */
async function memoStillValid(workspaceId: string, record?: SessionAttach): Promise<boolean> {
  try {
    const inspection = await inspectEntry()
    // `retried: true` — this is not the place to revive anything. If the engine
    // is down, the memo is not valid and a fresh attach decides what to do.
    const plan = planForEntry(inspection, workspaceId, true)
    if (plan.act !== "check-version") {
      log.info("cached attach no longer describes a reusable engine; re-deciding", {
        workspaceId,
        act: plan.act,
      })
      return false
    }

    // The FLOOR is what makes the pin trustworthy, since engines below it do not
    // lock it. Re-probed only when the command CHANGES, because probing spawns a
    // process and this runs every turn. The residual is narrow and worth naming:
    // a binary swapped in place under an unchanged command is not caught until
    // the next session.
    const command = commandArgv(inspection.entry).join(" ")
    if (record && record.validated === command) return true
    const found = await engineVersionOf(inspection.entry)
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
/** Test seam — the session map itself, for asserting wait bookkeeping. */
export function sessionsForTests(): Map<string, { waitTimedOut?: boolean }> {
  return sessions as unknown as Map<string, { waitTimedOut?: boolean }>
}

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
  // A previous timeout must not silence the wait forever. Re-validating a
  // settled memo is a status read and a config read with no spawn — bounded, and
  // cheap enough that a turn should always wait for it, because during that
  // window the outcome reads as "not settled" and a consumer that fails open on
  // that will quietly stop routing for the turn and announce it. The no-wait
  // rule belongs to the attach that earned it: a repair that can spawn, or a
  // spawn still in flight from an earlier turn.
  const stillInFlight = !!previous && previous.outcome === undefined
  const entry = {
    key: previous?.key,
    waitTimedOut: repairRetry || (!!previous?.waitTimedOut && stillInFlight),
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
        !wasServing(previous!.outcome) || !boundTo || (await memoStillValid(boundTo, entry))
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
      const outcome: Outcome = { kind: "connect-failed", error }
      await announceRefusal(
        outcome,
        {
          title: "Workspace engine attach failed",
          message: `Could not attach the workspace engine: ${error}. Integration tools are unavailable for this session.`,
          variant: "error",
        },
        { sessionID },
      )
      return outcome
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
