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
  sameEntry,
  ENGINE_BINARY,
  INSTALL_HINT,
  MIN_ENGINE_VERSION,
  type ExistingEntry,
  type McpStatus,
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
  sameEntry,
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
 * attribution, attribution outranks version. Each of those checks is defeated
 * by sitting on the wrong side of another, and an await between them — a config
 * read, a status call, a version probe — is what lets that happen. A function
 * that cannot await cannot reorder itself.
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
  /** Every server MCP knows about, not only ours.
   *
   * Kept from the status read the inspection already performs, so a question
   * about the neighbours costs no second call — and is answered from the same
   * moment as everything else this inspection decided from. */
  all?: McpStatus
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
/** The engine that is RUNNING, else the one configured.
 *
 * Every question about the running engine — its version, its pin, how it is
 * described to a user — goes through here, because the answer is not always the
 * config: a config edit can change the command while the existing client stays
 * connected, so the two can carry the same pin and be different binaries.
 *
 * It is one function rather than an expression at each call site so that there
 * is no second place to write it. The same question was asked correctly in one
 * site and incorrectly in the site beside it twice, and both times the second
 * site was found by someone reading the two together rather than by the person
 * fixing the first. A shared expression is a trap of exactly that shape.
 *
 * The fallback matters: with no runtime record, nothing of ours is running and
 * the configured entry is the only evidence there is. */
export function runningEngine(inspection: Inspection): ExistingEntry | null {
  return inspection.runtime ?? inspection.entry
}

/** The entry the user CONFIGURED, whatever may be running.
 *
 * The mirror of `runningEngine`, and it exists for the same reason: so that
 * every read is a named question rather than a field access whose meaning has
 * to be inferred from its surroundings. Naming only one of the two would leave
 * the other implicit, which is the condition this class of defect grows in.
 *
 * Use this where the question really is about configuration — what the user
 * asked for, what a pin declares, what a message should describe — and
 * `runningEngine` where it is about the process that is actually up. */
export function configuredEntry(inspection: Inspection): ExistingEntry | null {
  return inspection.entry
}

async function inspectEntry(): Promise<Inspection> {
  const entry = await existingEntry(DATAMATE_KEY)
  const client = mcp()
  const all = await client.status()
  const runtime = client.spawned ? await client.spawned(DATAMATE_KEY).catch(() => undefined) : undefined
  return { entry, observed: all[DATAMATE_KEY], runtime, all }
}

export function planForEntry(inspection: Inspection, workspaceId: string, retried: boolean): EntryPlan {
  const entry = configuredEntry(inspection)
  const { observed } = inspection

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
  const running = runningEngine(inspection)
  const runtimeKnown = running !== entry
  const runtimePin = runtimeKnown ? pinnedWorkspace(running) : null
  if (runtimeKnown && runtimePin !== workspaceId) {
    return {
      act: "replace-unattributable",
      entry: describeEntry(running),
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

/** The last verdict announced to a session — stored ON the session record.
 *
 *
 * Repairable refusals are re-decided every turn — deliberately, because that is
 * how a repair gets noticed — but re-DECIDING is not a reason to re-TELL. A
 * missing engine, an unreadable config or a below-floor binary that has not
 * changed produced an identical toast on every single turn, which is nagging
 * rather than informing. It matters more once the toast becomes a dialog: one
 * dialog per turn would be unusable.
 *
 * Keyed by session and by the verdict itself, so a CHANGED verdict speaks, and a
 * successful attach clears it so the next problem is heard.
 *
 * NOT a module-level map of its own. A second map keyed by session id is a
 * second thing to evict, and this one would only ever grow on the sessions that
 * never succeed — a long-running server whose new sessions keep hitting
 * `engine-missing` would retain every one of them. Hanging it on the session
 * record means it is bounded by whatever bounds the sessions, which is already
 * solved and already tested. */
function verdictSignature(outcome: Outcome, workspaceId?: string): string {
  const detail =
    "error" in outcome ? outcome.error : "found" in outcome ? outcome.found : "declared" in outcome ? "" : ""
  // The workspace is part of the identity. Without it, a session re-linked from
  // A to B is silenced about B by an identical-kind refusal it was told about
  // for A — the record is carried across the re-link, so the user is left with
  // guidance naming a workspace they have left. "Same verdict" has to mean the
  // same verdict about the same thing.
  return `${workspaceId ?? "-"}:${outcome.kind}:${detail}`
}

/** Forget what a session was last told, so the next verdict is announced even if
 * it repeats an older one. Called when an attach succeeds: the problem the user
 * was told about is gone, and if it comes back they should hear about it. */
function clearAnnouncement(sessionID: string): void {
  const record = sessions.get(sessionID)
  if (record) record.announced = undefined
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
/** What the announcement knows about the refusal beyond the outcome itself.
 *
 * `Outcome` carries `found` and `declared` but no workspace identity, and the
 * announcement needs one: a message that names the workspace, and anything
 * keyed per workspace downstream.
 *
 * Every field is OPTIONAL, and that is the contract rather than laziness. This
 * function is the single exit for exceptions as well as decisions, and a throw
 * can happen before a binding is resolved — the flag read, the MCP handle, the
 * serialization chain all precede it. A body that assumes a workspace is here
 * will crash on the one path nobody writes a fixture for. When identity is
 * absent the toast still fires; anything that needs to NAME a workspace must
 * stay silent rather than guess at one. */
type RefusalContext = {
  workspaceId?: string
  workspaceName?: string
  sessionID?: string
}

async function announceRefusal(outcome: Outcome, toast: Toast, context?: RefusalContext): Promise<void> {
  try {
    const record = context?.sessionID ? sessions.get(context.sessionID) : undefined
    if (record) {
      const signature = verdictSignature(outcome, context?.workspaceId)
      if (record.announced === signature) {
        log.info("verdict unchanged since the last turn; not repeating it", {
          sessionID: context?.sessionID,
          kind: outcome.kind,
        })
        return
      }
      record.announced = signature
    }
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

async function run(sessionID: string): Promise<Outcome> {
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
    // This read is DIAGNOSTIC — it produces a log line and nothing else — so a
    // failure to perform it must not change the outcome. Making the reader
    // propagate was right for the paths that DECIDE on it, and this caller
    // silently inherited that: a failed read here escaped to the catch-all and
    // announced "Workspace engine attach failed" in a project with no workspace
    // linked, where this module is documented inert — and because that outcome
    // is repairable, it re-announced on every turn for as long as the config
    // stayed unreadable.
    //
    // Propagating a failure is the right default, but it turns every caller that
    // relied on the swallow into a decision that now has to be made explicitly.
    // Here the decision is easy, because nothing is riding on the answer.
    try {
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
    } catch (err) {
      log.warn("could not inspect the stale entry in an unbound project; nothing depends on it", {
        err: String(err),
      })
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

  /** The PATH engine's version, probed at most once per attach.
   *
   * Probing spawns a process and takes about a second. Two paths ask the same
   * question — "is there something better on PATH than the entry we just
   * rejected" and "what would we spawn" — and the below-floor path reaches both,
   * so a replaced pre-floor engine paid for the same answer twice. */
  let pathProbe: { bin: string | null; version: string | null } | undefined
  const enginePath = async (): Promise<{ bin: string | null; version: string | null }> => {
    if (!pathProbe) {
      const bin = which(ENGINE_BINARY)
      let version: string | null = null
      try {
        version = bin ? await versionOf(bin) : null
      } catch (err) {
        // Same rule as the entry probe: unreadable is below the floor, not a
        // reason to abandon the turn to the catch-all.
        log.warn("could not probe the PATH engine version; treating it as unreadable", {
          workspaceId,
          err: String(err),
        })
      }
      pathProbe = { bin, version }
    }
    return pathProbe
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
   * mutation on a stale binding" but "no mutation on a stale world".
   *
   * It does NOT make the window vanish. The write re-checks intent on the same
   * text it modifies, which is as close as that can be got, but one read and one
   * write to one file is not atomic — see the note on `persist`. This guard
   * narrows the window; it does not close it. */
  const worldUnchanged = async (
    // The entry the PLAN was derived from, when the caller is about to act on
    // that plan. Given only before a write: acting on a plan whose entry has
    // been replaced overwrites a newer entry and can displace the client it
    // started.
    //
    // Deliberately NOT given after the write. By then the entry on disk is our
    // own, so there is nothing to compare a plan against — and a third-party
    // rewrite landing after our write is a different question, answered by the
    // undo, which already refuses to roll back an entry that is no longer ours.
    expected?: ExistingEntry | null,
  ): Promise<"ok" | "moved" | "disabled" | "unreadable" | "replaced"> => {
    // Intent FIRST, binding LAST — reversed again, and this is the considered
    // order rather than the obvious one.
    //
    // Reading the binding first put it one whole config read away from every
    // mutation it guards, so a re-link landing inside that read installed for the
    // workspace the project had just left and was only undone after the engine
    // had booted with the per-project lock held. That is the exact defect this
    // guard was written for, reintroduced by the guard's own ordering.
    //
    // Intent does not need to be last, because the write re-checks intent on the
    // same text it modifies — so the intent window is covered whichever read
    // comes first. The binding has no such second line of defence, so it takes
    // the adjacent position. On the re-add path there is no write-side check at
    // all and one half is necessarily a read away; the binding still goes last,
    // because a stale binding starting another workspace's engine under the lock
    // is the worse of the two harms.
    let entryNow: ExistingEntry | null
    try {
      entryNow = await existingEntry(DATAMATE_KEY)
    } catch (err) {
      // Fails CLOSED. `null` from this read means "there is no entry", which
      // reads as permission to write — so a read that merely FAILED must not
      // produce it. If intent cannot be confirmed, nothing is written.
      log.warn("could not confirm intent before mutating; abandoning the attach", {
        workspaceId,
        err: String(err),
      })
      // NOT "moved". The same failure reaching the inspection is reported to the
      // user; reporting it here as a silent binding-move would give one failure
      // two labels and two signal counts depending only on which read hit it.
      return "unreadable"
    }
    if (entryNow?.enabled === false) {
      log.info("intent changed while deciding; not writing over a disable", { workspaceId })
      return "disabled"
    }
    // The plan was derived from a particular entry. If that entry has been
    // REPLACED — a different enabled command, or a URL where a command was —
    // the plan describes something that is no longer there, and acting on it
    // overwrites a newer entry and can displace the client it started. A
    // disable is one way the entry can change; it is not the only one.
    if (expected !== undefined && !sameEntry(entryNow, expected)) {
      log.info("the entry was replaced while deciding; re-deciding rather than acting on a stale plan", {
        workspaceId,
      })
      return "replaced"
    }
    if (!(await stillCurrent())) return "moved"
    return "ok"
  }

  /** Say once that a hosted datamate is also serving this session.
   *
   * `datamate_manager` can add standalone `datamate-<name>` entries pointing at
   * the hosted endpoint, and those keep their own clients. This flow owns one
   * key and does not touch theirs, so after a successful attach the model can
   * hold both tool sets at once — ours for the bound workspace, and another
   * datamate's under its own credentials.
   *
   * Not filtered: the user added those servers deliberately, and removing a
   * server from their turns is not this module's decision to make. Surfaced
   * instead, so the ambiguity is visible rather than silent.
   *
   * One signal per session per SET, so a stable configuration says it once and a
   * change says it again. Separate from the attach toast on purpose: two
   * different things happened, so there are two signals — the rule is one signal
   * per event, not one element per screen. */
  const noteHostedNeighbours = async (outcome: Outcome): Promise<void> => {
    if (!attributableEngine(outcome)) return
    try {
      const hosted = Object.entries(inspection.all ?? {})
        .filter(
          ([key, value]) =>
            key !== DATAMATE_KEY && key.startsWith(`${DATAMATE_KEY}-`) && value?.status === "connected",
        )
        .map(([key]) => key)
        .sort()
      if (hosted.length === 0) return
      const signature = hosted.join(",")
      const record = sessions.get(sessionID)
      if (record?.announcedHosted === signature) return
      if (record) record.announcedHosted = signature
      await notify({
        title: "Another datamate is also connected",
        message:
          `Workspace "${binding.datamateName}" is attached, and ${hosted.join(", ")} ` +
          `${hosted.length === 1 ? "is" : "are"} also connected. Tools from ${hosted.length === 1 ? "it" : "them"} ` +
          `serve a different datamate, under its own credentials — check which you are using before running one.`,
        variant: "warning",
      })
    } catch (err) {
      log.warn("could not check for other connected datamate servers", { workspaceId, err: String(err) })
    }
  }

  /** The refusal an unreadable configuration earns.
   *
   * One failure, one label, wherever it lands: the reader propagates rather than
   * inventing an answer, so both the inspection and the pre-write guard reach
   * this. Nothing is written on the way here. */
  const refuseUnreadable = (why: string): Promise<Outcome> =>
    refuse({ kind: "connect-failed", error: `configuration unreadable: ${why}` }, {
      title: "Workspace engine not attached",
      message:
        `Could not read this project's MCP configuration, so the engine was not attached — acting on a ` +
        `configuration we cannot read risks overwriting your own "${DATAMATE_KEY}" entry. Integration tools ` +
        `are unavailable until it can be read.`,
      variant: "error",
    })

  /** The refusal a mid-decision disable earns.
   *
   * Reported as `entry-disabled` rather than `superseded` because the guard
   * knows WHICH half of the world moved, and the two mean different things to a
   * user: one says "something changed, try again", the other says "you switched
   * this off, and it stays off". Collapsing them would throw away the more
   * useful answer at the point we finally have it. */
  const refuseDisabled = (): Promise<Outcome> =>
    refuse(
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
  /** Close the client, but only if it is still the one we judged.
   *
   * Every destructive act verifies identity first, and it does so HERE so there
   * is no second place to remember it. The MCP route and the IDE's reload both
   * call `MCP.add` outside this flow's serialization, so between judging a
   * client and closing it, someone else's replacement can take its place — and
   * closing that leaves the engine they just asked for disconnected, with its
   * tools and credentials gone from the turn. */
  const removeIfOurs = async (
    judged: ExistingEntry | null,
    why: Record<string, unknown>,
    bindingDependent = false,
  ): Promise<void> => {
    // Identity FIRST, binding LAST, so the binding read stays the last await
    // before the mutation. Both checks live here rather than one here and one at
    // the call site, because ordering two guards across two functions is how one
    // of them ends up on the wrong side of the other.
    const runningNow = client.spawned ? await client.spawned(DATAMATE_KEY).catch(() => undefined) : undefined
    if (runningNow && judged && !sameEntry(runningNow, judged)) {
      log.info("not detaching; something else replaced this client since we judged it", { workspaceId, ...why })
      return
    }
    if (bindingDependent && !(await stillCurrent())) {
      log.info("skipping teardown; the binding changed while this attach was deciding", { workspaceId, ...why })
      return
    }
    await client.remove(DATAMATE_KEY).catch((err) => {
      log.warn("could not detach the rejected engine entry", { err: String(err), ...why })
    })
  }

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
    await removeIfOurs(runningEngine(inspection), why, bindingDependent)
  }
  /** Abandon an install without trace.
   *
   * Both halves, together. A supersede that undoes only the runtime leaves our
   * pin on disk, and MCP bootstrap starts every enabled entry — so a restart
   * before the next attach starts the workspace this project walked away from.
   * Naming them as one operation is what stops a caller remembering only one.
   *
   * `projectBefore` is the PROJECT file's own entry, not the merged view.
   * Restoring the merged value writes a copy of a global entry into the project,
   * which is a permanent override shadowing every later global change — undoing
   * a write is only correct if it restores what that write replaced. */
  const undoInstall = async (
    projectBefore: ExistingEntry | null,
    installed: LocalMcpConfig,
  ): Promise<"restored" | "failed"> => {
    // An undo may only undo its OWN work, and both halves are checked because
    // either can be replaced between the install and the undo: the MCP route and
    // the IDE's reload both call `MCP.add` outside this flow's serialization,
    // and an IDE or the user may rewrite the file. Removing or restoring blindly
    // destroys someone else's work while believing it is tidying up after
    // itself.
    await removeIfOurs(installed, { reason: "undoing our install" })
    // "Restore what the write replaced" stops being right the moment anything
    // edits the thing we wrote. Between the install and this undo there is a
    // whole engine boot: a disable landing in that window lands on OUR entry,
    // and so does a new command or URL from an IDE. Restoring the pre-install
    // state discards that edit, and the next turn — finding no entry, or ours —
    // spawns over it.
    //
    // The same rule as the guard, applied to the undo's own write: no mutation
    // on a stale world. Read at undo time, and restore only what is still ours.
    let now: ExistingEntry | null = null
    try {
      now = await projectEntry(configPath)
    } catch (err) {
      // Fails CLOSED, like the guard's read and for the same reason. Restoring
      // "what we replaced" on a read we could not perform can overwrite a
      // disable that landed while we held the entry — writing blind is how the
      // undo becomes the thing that needs undoing. Leave the file alone and let
      // the caller tell the user what is still there.
      log.warn("could not read the project entry before undoing; leaving the file alone", {
        workspaceId,
        err: String(err),
      })
      return "failed"
    }
    if (now?.enabled === false) {
      log.info("the entry was disabled while we held it; keeping the disable rather than undoing it", {
        workspaceId,
      })
      const keep = projectBefore ? ({ ...projectBefore, enabled: false } as ExistingEntry) : now
      return await persistRestore(DATAMATE_KEY, keep, configPath)
    }
    if (now && !sameEntry(now, installed)) {
      // Rewritten while we held it — a different command, or a URL where we
      // wrote a command. That edit is newer than our pin and not ours to undo.
      log.info("not restoring; the entry was rewritten since we installed", { workspaceId })
      return "restored"
    }
    return await persistRestore(DATAMATE_KEY, projectBefore, configPath)
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
    // Revalidate before answering. A refusal is an answer: without this, a
    // re-link during the config read reports `engine-missing` for the workspace
    // the project has just left, and toasts a message naming it.
    if (!(await stillCurrent())) {
      log.info("binding changed before this refusal could be reported; not answering for the old workspace", {
        workspaceId,
        kind: outcome.kind,
      })
      return { kind: "superseded" }
    }
    await announceRefusal(outcome, toast, { workspaceId, workspaceName: binding.datamateName, sessionID })
    return outcome
  }

  // Read the entry BEFORE asking for status. `existingEntry` refreshes the config
  // cache and `MCP.status()` reads that same cache — so an entry an IDE or user
  // added after the cache was warmed is missing from status entirely, `existing`
  // is undefined, rule 1 never runs, and we persist our managed entry straight
  // over theirs. Refreshing first is what makes the status gate trustworthy.
  // Intent, then connectivity, then attribution, then version.
  //
  // Each check is defeated by sitting on the wrong side of another, and an
  // await between them is what lets that happen. `planForEntry` cannot await,
  // so no such reordering is expressible against it.
  //
  // The entry is read BEFORE the status it is judged against. `existingEntry`
  // refreshes the config cache that `MCP.status()` then reads, so an entry an
  // IDE added after the cache warmed would otherwise be missing from status
  // entirely — the entry check would never run and our managed entry would be
  // persisted straight over theirs.
  let inspection: Inspection
  try {
    inspection = await inspectEntry()
  } catch (err) {
    // Planning on a configuration we could not read means planning "there is
    // nothing here", which is a spawn — straight over whatever is actually
    // there.
    return await refuseUnreadable(String(err))
  }
  let plan = planForEntry(inspection, workspaceId, false)

  /** Did THIS attach start the client that is now registered?
   *
   * Scoped to the whole attach rather than to the revive block, because the
   * teardown that matters happens later. By the teardown split's own definition
   * — undoing what this attach created is right regardless of what is bound now
   * — a client we revived is binding-INDEPENDENT, but it was exiting through the
   * binding-dependent gate: revive, then a re-link plus an unpinning rewrite in
   * the same window, and the teardown is correctly skipped as "might belong to
   * the new binding" while being a process we started seconds earlier.
   *
   * The definition was right and the plumbing did not carry it this far. */
  let revived = false

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
    // The whole transport, not just the argv. `environment`, `cwd` and
    // `timeout` are what the configured engine was meant to run under — a
    // custom PATH may be the only place its binary exists, and a relative
    // command resolves from `cwd`. Reviving with a flattened shadow of the
    // entry restarts a different process than the one that failed.
    const configured = configuredEntry(inspection)
    const revive: LocalMcpConfig = {
      type: "local",
      command: commandArgv(configured),
      enabled: true,
      ...(configured?.environment ? { environment: configured.environment } : {}),
      ...(configured?.cwd ? { cwd: configured.cwd } : {}),
      ...(configured?.timeout !== undefined ? { timeout: configured.timeout } : {}),
    }
    // The whole world, not just the binding: this starts a process, and a
    // disable that landed since the inspection forbids starting it just as
    // surely as it forbids writing config. The plan was derived from a snapshot
    // taken before a status read; re-confirm both halves before acting on it.
    // No expected entry here. The revive re-inspects and re-plans immediately
    // afterwards, so a change landing between the inspection and the restart is
    // absorbed by that — this guard only has to answer intent and the binding.
    // The spawn path is different: it acts on its plan with no further look.
    const beforeRevive = await worldUnchanged()
    if (beforeRevive === "disabled") return await refuseDisabled()
    if (beforeRevive === "unreadable") return await refuseUnreadable("intent could not be confirmed")
    if (beforeRevive !== "ok") return { kind: "superseded" }
    await client
      .add(DATAMATE_KEY, revive)
      .then(() => {
        revived = true
      })
      .catch((err) => {
        log.warn("could not restart the engine entry", { err: String(err), workspaceId })
      })
    // Re-inspected whole rather than re-reading status alone: the world may
    // have moved in both halves while we were starting a process.
    //
    // A revive is an install, so it owns its undo like one. A throw in the
    // re-inspection must not reach the catch-all with the client we just
    // started still registered: the outcome is advice, the registration is what
    // the model sees.
    try {
      inspection = await inspectEntry()
    } catch (err) {
      if (revived) {
        log.info("undoing the revive we started, since we cannot decide about it", { workspaceId })
        await removeIfOurs(revive, { reason: "undoing our revive" })
      }
      throw err
    }
    plan = planForEntry(inspection, workspaceId, true)
  }
  const entry = configuredEntry(inspection)

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
    // "It will not start" and "there is nothing to start" are different
    // situations with different remedies, and an entry pinned to us whose binary
    // has since been uninstalled looks exactly like the first while being the
    // second. Reported as `connect-failed`, it produced a message with no
    // install hint, every turn, forever — and `which` was never consulted on
    // this path at all.
    if (!which(ENGINE_BINARY)) {
      const declaredForMissing = await declaredBounded(workspaceId)
      const count = declaredForMissing?.keys.length ?? 0
      return await refuse({ kind: "engine-missing", declared: count }, {
        title: "Workspace integrations unavailable",
        message:
          `Workspace "${binding.datamateName}" declares ${count} integration tool${count === 1 ? "" : "s"}. ` +
          `They run on the local engine, which is not installed. Install it with: ${INSTALL_HINT}`,
        variant: "warning",
      })
    }
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
    // `!revived` — if we started this client, tearing it down is undoing our own
    // work and never depends on the binding.
    await detachRejected({ workspaceId, reason: "not-attributable", pinnedTo: plan.pinnedTo }, !revived)
  }

  if (plan.act === "check-version") {
    // A probe that THROWS is a version we could not read, which `clearsFloor`
    // already treats as below the floor — an engine that cannot say what it is
    // cannot be shown to lock its pin. Letting it propagate instead sent the
    // turn to the catch-all BEFORE any teardown, so a persistent probe failure
    // toasted every single turn while the rejected client stayed registered and
    // serving: the advice-versus-registration split this module exists to close.
    // Read as unreadable, it is detached and refused once, and the memo holds.
    // The RUNNING engine, not the configured one. A config edit can change the
    // command while the existing client stays connected, so the two can carry
    // the same pin and be different binaries — and a newly configured 0.7
    // command would then authorise reuse of a still-running pre-0.7 engine,
    // which does not lock its pin and can drift to another workspace. The pin
    // and the floor are one mechanism, so both are asked of the same thing.
    let found: string | null
    try {
      found = await engineVersionOf(runningEngine(inspection))
    } catch (err) {
      log.warn("could not probe the entry's engine version; treating it as unreadable", {
        workspaceId,
        err: String(err),
      })
      found = null
    }
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
        await removeIfOurs(runningEngine(inspection), { reason: "superseded while reusing" })
        return { kind: "superseded" }
      }
      clearAnnouncement(sessionID)
      log.info("reusing existing engine entry", {
        workspaceId,
        available,
        version: found,
        declared: declaredKeys?.keys.length,
        missing,
      })
      const reused: Outcome = {
        kind: "reused",
        available,
        ...(declaredKeys ? { declared: declaredKeys.keys.length, missing } : {}),
      }
      await noteHostedNeighbours(reused)
      return reused
    }

    // Pinned to us, but below the floor or unreadable. Prefer a newer engine on
    // PATH over keeping one whose pin the engine does not lock; if PATH cannot
    // do better, say so rather than reuse it silently.
    //
    // PATH is probed HERE rather than inside the plan because probing spawns a
    // process: folding it into the pure decision would charge the reuse path —
    // the common one, run on every turn — for a question it never asks.
    const { version: pathVersion } = await enginePath()
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
    // Binding-INDEPENDENT, exactly like its irreplaceable sibling: an engine
    // below the floor serves nobody correctly, whatever the project is bound to
    // now. Gating this on the binding would let a re-link during the version
    // probes leave a too-old client connected and serving under a silent
    // `superseded`.
    await detachRejected({ workspaceId, reason: "below-floor-replaceable", found }, false)
  }

  // Bounded: this lookup is reporting only, but it runs BEFORE the engine is
  // launched and its HTTP layer has no abort timeout — so an API that accepts a
  // connection and then stalls stopped a good cached binding and an installed
  // engine from ever attaching. Reporting degrades; attaching does not wait.
  const declaredKeys = await declaredBounded(workspaceId)
  const declaredCount = declaredKeys?.keys.length ?? 0

  // Rule 2 / 3 — opportunistic use, or an offer. Never an install.
  const { bin, version: found } = await enginePath()
  if (!bin) {
    return await refuse({ kind: "engine-missing", declared: declaredCount }, {
      title: "Workspace integrations unavailable",
      message:
        `Workspace "${binding.datamateName}" declares ${declaredCount} integration tool${declaredCount === 1 ? "" : "s"}. ` +
        `They run on the local engine, which is not installed. Install it with: ${INSTALL_HINT}`,
      variant: "warning",
    })
  }

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
  // write it protects, which is a window a re-link can land in.
  // If we cannot record what to put back, we do not write. An unreadable
  // config read that fails must not read as "no entry here": a later restore
  // acts on that by REMOVING, so it would delete the user's own entry as the
  // undo of an attach meant to leave it alone.
  // The path FIRST, and then the snapshot read from that exact path. Resolving
  // twice means the snapshot can come from one file while the write goes to
  // another — an IDE creating or removing a higher-priority config between the
  // two is enough — after which the undo restores the first file's entry into
  // the second, over whatever the user had there. One resolution, used by the
  // read, the write and the undo alike.
  let configPath: string
  try {
    configPath = await projectConfigPath()
  } catch (err) {
    // Falling back to persist's own resolution would write to a path we could
    // not resolve here, which the undo then re-resolves independently — two
    // guesses about which file we touched. If we cannot say where we would
    // write, we do not write.
    return await refuseUnreadable(`config path could not be resolved: ${String(err)}`)
  }
  // If we cannot record what to put back, we do not write. An unreadable
  // config read that fails must not read as "no entry here": a later restore
  // acts on that by REMOVING, so it would delete the user's own entry as the
  // undo of an attach meant to leave it alone.
  let projectBefore: ExistingEntry | null
  try {
    projectBefore = await projectEntry(configPath)
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
  const beforeInstall = await worldUnchanged(configuredEntry(inspection))
  if (beforeInstall === "disabled") return await refuseDisabled()
  if (beforeInstall === "unreadable") return await refuseUnreadable("intent could not be confirmed")
  if (beforeInstall !== "ok") {
    // Re-linked while we were probing. Installing now would attach a workspace
    // this session has left, and would win by arriving first.
    log.info("abandoning attach; the binding changed before the engine was installed", { workspaceId })
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
  // Distinct from `committed`: whether anything was actually written or
  // registered. A write refused at the last moment left nothing behind, and the
  // undo must not "restore" over a config it never touched.
  let installed = false
  let undone = false
  /** Give back both halves, once, before anything else happens.
   *
   * In-region refusals undo before they announce, which is the rule `refuse`
   * states for every other exit: stop serving first, explain second. The
   * announcement is a substitution point, and a body that waits on a person
   * would otherwise leave a failed engine's registration and its pin outliving
   * the dialog, with a restart inside it bootstrapping the entry we had already
   * decided against.
   *
   * Idempotent, so the `finally` stays as a backstop for exits nobody wrote. */
  const undoNow = async (): Promise<void> => {
    if (!installed || undone) return
    undone = true
    const restored = await undoInstall(projectBefore, cfg).catch((err) => {
      log.warn("could not undo a non-attached install", { err: String(err), workspaceId })
      return "failed" as const
    })
    if (restored === "failed") {
      // An undo that could not be confirmed is an actionable failure, not a
      // quiet one. Our pin is still on disk and MCP bootstraps every enabled
      // entry, so the next restart starts the workspace this attach walked away
      // from — and nothing else will ever mention it. `superseded` stays silent
      // only when there is genuinely nothing left behind.
      await announceRefusal(
        { kind: "connect-failed", error: "restore failed" },
        {
          title: "Workspace engine config left behind",
          message:
            `The engine entry for workspace "${binding.datamateName}" was installed and then abandoned, but the ` +
            `previous "${DATAMATE_KEY}" entry could not be restored${configPath ? ` in ${configPath}` : ""}. ` +
            `That pin is still on disk and will start on the next restart; edit or remove it to be sure.`,
          variant: "error",
        },
        { workspaceId, workspaceName: binding.datamateName, sessionID },
      )
    }
  }
  try {
    if ((await persist(DATAMATE_KEY, cfg, configPath)) === "disabled") {
      // A disable landed between our guard and the write, and the write saw it.
      // Nothing was written and nothing registered.
      log.info("write refused: the entry is disabled on disk", { workspaceId })
      return await refuseDisabled()
    }
    installed = true
    await client.add(DATAMATE_KEY, cfg)

    // Rule 4 — a failed local engine is reported, never routed around.
    const after = (await client.status())[DATAMATE_KEY]
    if (after?.status !== "connected") {
      const error = after?.error ?? after?.status ?? "not connected"
      // Undo BEFORE announcing — see `undoNow`.
      await undoNow()
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
    // handshake AND the tool listing. Both are windows a re-link can land in;
    // guarding only the first leaves a flip during the tool read with the
    // previous workspace installed and reported as attached.
    //
    // Late rather than early on purpose: the check is only meaningful at the
    // last moment before we announce and answer, because everything before that
    // is still revocable. The undo itself now belongs to the region.
    // After the write, "has the world moved" becomes "is what is SERVING still
    // mine". The runtime is the half that matters here: an IDE reload or the MCP
    // route can replace the client during the status and tool awaits, and
    // committing without asking would report the bound workspace as served by a
    // client that is unpinned or pinned elsewhere — whose tools and credentials
    // then reach the model.
    //
    // The config half is deliberately not compared here. What is on disk after
    // our write is our own, and an edit landing on it afterwards belongs to the
    // undo, which already refuses to roll back an entry that is no longer ours.
    const afterInstall = await worldUnchanged()
    const runningNow = client.spawned ? await client.spawned(DATAMATE_KEY).catch(() => undefined) : undefined
    if (afterInstall === "ok" && runningNow && !sameEntry(runningNow, cfg)) {
      log.info("the client we installed was replaced before we could report it; undoing", { workspaceId })
      await undoNow()
      return { kind: "superseded" }
    }
    if (afterInstall !== "ok") {
      log.info("the world changed before the attach could be reported; undoing what we installed", {
        workspaceId,
        why: afterInstall,
      })
      // Either way the install is undone by the region. A disable reports itself
      // so the user learns their edit took effect, rather than a generic race.
      await undoNow()
      if (afterInstall === "disabled") return await refuseDisabled()
      if (afterInstall === "unreadable") return await refuseUnreadable("intent could not be confirmed")
      return { kind: "superseded" }
    }

    // Ours, and staying. Answer BEFORE announcing: `announceToolsChanged` and
    // the toast are two more awaits, and the outcome asserts which workspace is
    // served — so it is fixed while that assertion is still true.
    committed = true
    // The problem the user was last told about is gone. If it returns, they
    // should hear about it rather than have it deduplicated against a verdict
    // from before the repair.
    clearAnnouncement(sessionID)
    const outcome: Outcome = {
      kind: "attached",
      available,
      declared: declaredCount,
      missing,
      ...(replaced ? { replaced } : {}),
    }
    log.info("attached workspace engine", { workspaceId, available, declared: declaredCount, missing, replaced })

    // Announce it so a turn that had already given up waiting still learns the
    // tools arrived — and never let announcing change what happened.
    //
    // These two awaits carry no no-throw guarantee at the seam; only the
    // production bodies happen to swallow, and the region did not encode that
    // dependency. A throw here escaped to the catch-all and reported
    // `connect-failed` for an engine that is attached, connected and persisted
    // — the single toast telling the user the attach failed while the tools are
    // in fact there. Describing an outcome must never rewrite it, on the success
    // path exactly as on the refusal path.
    try {
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
    } catch (err) {
      log.warn("could not announce the attach; the engine is attached regardless", {
        workspaceId,
        err: String(err),
      })
    }
    await noteHostedNeighbours(outcome)
    return outcome
  } catch (err) {
    // Undo first, then decide how to report. A throw that lands after a re-link
    // is the same situation as any other refusal for a workspace the project has
    // left: answering names the wrong workspace and toasting is worse. The
    // catch-all announces every throw it sees, so this one must not reach it.
    // The `finally` performs the undo — one backstop, not two. It runs before
    // this function's value reaches the caller, and before the catch-all
    // announces anything, so the ordering that matters still holds.
    if (!(await stillCurrent())) {
      log.info("attach threw after the binding moved; not answering for the old workspace", {
        workspaceId,
        err: String(err),
      })
      return { kind: "superseded" }
    }
    throw err
  } finally {
    if (!committed) {
      await undoNow()
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
  /** The last verdict this session was told about — see `verdictSignature`. */
  announced?: string
  /** The set of hosted datamate servers this session has been told about. */
  announcedHosted?: string
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
 * Validated by the SAME reader and the SAME decision as a fresh attach. This is
 * the common path — every turn after the first takes it — and a second
 * implementation of the decision would be a second place for it to be wrong.
 *
 * "Still valid" is the plan saying reuse. Nothing else. */
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
    // lock it — and like the pin, it is a question about the engine that is
    // RUNNING. Probing the configured command instead lets a newly configured
    // modern binary vouch for a running pre-floor one under the same pin, and
    // record that as validated for the rest of the session.
    //
    // Re-probed when either command changes, because probing spawns a process
    // and this runs every turn. A divergence between the two IS the case that
    // needs re-probing, so the key carries both. The residual is narrow and
    // worth naming: a binary swapped in place under an unchanged command is not
    // caught until the next session.
    const running = runningEngine(inspection)
    const command = `${commandArgv(running).join(" ")}|${commandArgv(configuredEntry(inspection)).join(" ")}`
    if (record && record.validated === command) return true
    const found = await engineVersionOf(running)
    if (!clearsFloor(found)) {
      log.info("cached attach no longer clears the version floor; re-attaching", { workspaceId, found })
      return false
    }
    // Recorded on the CURRENT entry — the one that will be remembered and copied
    // forward. Writing it to the previous entry would be discarded next turn.
    if (record) record.validated = command
    return true
  } catch (err) {
    // Fails CLOSED. Returning true would serve a memo whose world could not be
    // confirmed — a disabled entry or a moved pin riding a transient probe
    // error, on the path every turn after the first takes. Returning false
    // discards nothing: it routes back through `run()`, which re-inspects under
    // the per-project lock and either attaches or refuses through the single
    // exit, with no mutation. A failed read is never an answer.
    log.warn("could not confirm the cached attach; re-deciding rather than serving it", { err: String(err) })
    return false
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
    // Carried forward for the same reason `validated` is: a fresh entry is built
    // per call, so state that is not copied is state that is silently rebuilt —
    // and rebuilding this one turns "say it once" back into "say it every turn".
    announced: previous?.announced,
    announcedHosted: previous?.announcedHosted,
  } as SessionAttach
  // The whole task, not just the attach. `attachKey`, the memo re-validation and
  // the serialization chain all run BEFORE the attach's own catch, so a throw in
  // any of them escaped `ensure` as a rejected promise: no outcome, no toast,
  // and — since the caller starts this fire-and-forget — silence, which is the
  // one failure mode this module exists to remove. "Exactly one exit for throws
  // too" has to mean the whole task, or it names a boundary rather than a rule.
  entry.task = failSafely(sessionID, async (): Promise<Outcome> => {
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
    // Recomputed AFTER the awaited validation above: a re-link landing inside it
    // would otherwise file this fresh attach under the workspace key it started
    // with, and the turn would drop its wait for an attach that is no longer the
    // one it needs. Self-healing next turn, but a turn is what this exists to
    // save.
    const settledKey = await attachKey()
    entry.key = settledKey
    if (settledKey === key && sameWorkspace) {
      // Re-probing a repairable failure. Do NOT re-arm the wait: this runs on
      // every turn, and a retry that blocks would charge each one the full cap
      // (a `connect-failed` retry can sit in MCP's 30s connect budget). The
      // repaired engine's tools arrive over `tools/list_changed` instead.
      entry.waitTimedOut = true
    } else {
      // The binding changed under this session (or changed while we validated).
      // A fresh attach gets a fresh wait budget — the previous one was spent on a different workspace's engine.
      entry.waitTimedOut = false
      // Serialize against the attach being superseded. Both tasks end in
      // `MCP.add`, and whichever completes LAST owns the runtime client, so a
      // slower attach for the workspace we just left could otherwise land after
      // this one and restore its tools — with this session's memo already
      // settled, so no later turn would repair it.
      if (previous) await previous.task.catch(() => {})
    }
    return attachOnce(sessionID)
  })
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
/** Run an attach task so that NOTHING escapes as a rejection.
 *
 * Every explicit failure branch tells the user what is unavailable and why. An
 * unexpected throw must not be the single path that leaves them with neither
 * tools nor an explanation: the caller starts this fire-and-forget and
 * `whenAttached` returns void, so a rejection here is silence.
 *
 * Announced through the same exit as every decided refusal, and with NO
 * workspace identity — a throw can happen before a binding exists, so anything
 * downstream that wants to name a workspace has to cope with not having one. */
/** `String(err)` on a value with a null prototype throws INSIDE the catch, and
 * the task rejects after all — the one remaining route to a session whose
 * outcome never settles and whose await rejects into the prompt loop. Nothing in
 * this codebase throws such a value; the cost of being sure is three lines. */
function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return typeof err
  }
}

async function failSafely(sessionID: string, task: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await task()
  } catch (err) {
    const error = describeThrown(err)
    log.warn("workspace engine attach failed", { sessionID, err: error })
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
  }
}

function attachOnce(sessionID: string): Promise<Outcome> {
  return serializeAttach(() => run(sessionID))
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
