// altimate_change - new file
//
// Model-facing statement of Altimate Workspace identity: which workspace (if any) this
// project is linked to, rendered UNCONDITIONALLY so "this/current/active workspace" has
// exactly one deterministic answer every turn. Independent of `awareness.ts`, which
// exists to steer warehouse tool-call routing and is silent by design whenever no
// integration is served — correct for routing, wrong for identity. A user can ask
// "which workspace is my project connected to" on a session with zero served
// connections and still deserves a real answer.
//
// The naming conflict: "workspace" names two unrelated things in this product — the
// Altimate Workspace a project is *linked* to (`state.ts`'s binding), and other
// services' own use of the word (Databricks' native "workspace" concept, in
// particular). Nothing previously told the model which one "workspace" means when the
// user says it bare, so it could answer with whichever "workspace" happened to be
// nearby in context — confidently, and wrong. This module states the linked workspace
// (or its absence, or that it's currently unverifiable) explicitly, and instructs the
// model to resolve a genuine workspace-identity QUESTION to it — never to substitute
// another service's "workspace" as the answer. That instruction is deliberately scoped
// to an actual identity question (see `TRIGGER` below), not to every incidental mention
// of the word: an earlier draft fired on any appearance of "workspace" at all, which
// meant nagging about linking mid-conversation about an unrelated Databricks topic, or
// pedantically re-qualifying every casual mention of one. Neither is this feature's
// job — resolving "this/current/active workspace" is.
import { currentScope, onBindingChanged, readLocalBinding, resolveBindingOutcome, type BindingOutcome } from "./state"
import { workspaceLabel } from "./workspace-name"
import { isEnabled } from "./engine-seams"
import { Instance } from "../../project/instance"

/** Independent of `awareness.ts`'s MAX_SECTION_CHARS (2,000) — this section is a short,
 * fixed-shape identity statement, not an open-ended list of served integrations, so a
 * much smaller ceiling is enough. The label is budgeted separately (`MAX_LABEL_CHARS`
 * in `workspace-name.ts`) so the cap here is defense in depth and never cuts the
 * instruction itself: the fixed copy is ~640 characters, and a label at its budget
 * still leaves room. */
export const MAX_SECTION_CHARS = 1_000


const HEADING = "## Altimate Workspace"

/** The trigger for every active instruction below: a genuine workspace-IDENTITY
 * question from the user, not any incidental appearance of the word. Scoped this way
 * on purpose — an earlier draft said "whenever 'workspace' comes up" for the unbound
 * case, and an unconditional disambiguation rule for the bound case, and both were
 * over-triggering: a model that takes either literally interjects a linking pitch, or
 * pedantically re-qualifies every mention of a Databricks workspace, in the middle of
 * a conversation that was never about the Altimate Workspace at all. Restated once
 * here so both branches phrase the same condition identically. */
const TRIGGER =
  'the user\'s own message asks a workspace-IDENTITY question — "workspace" ' +
  'unqualified, or "this"/"current"/"active" workspace, used to ask what THIS ' +
  "project is connected to (not a passing mention of some other service's workspace)"

const LINK_HINT =
  'To link one: in this session, open the command palette and run "Link this project ' +
  "to a workspace\"; or run `altimate-code link` in a terminal."

/** Pure formatter — takes an already-resolved outcome so it is testable without
 * mocking the binding cache / network. `systemSection` below is the thin async
 * wrapper that actually resolves one. Enforces `MAX_SECTION_CHARS` itself (rather than
 * leaving it to the caller) so the cap is part of the pure, testable surface — the
 * guard is against a pathological workspace name, and every branch below is built from
 * one, so it belongs where the name is rendered. */
export function render(outcome: BindingOutcome, cap = MAX_SECTION_CHARS): string {
  const body = renderBody(outcome)
  if (body.length <= cap) return body
  // Fail closed rather than truncate: a cut instruction is worse than a missing
  // name. The name is the only variable field, so drop it and keep the id; if
  // even that does not fit, say nothing rather than something partial.
  if (outcome.status === "bound") {
    const unnamed = renderBody({ ...outcome, binding: { ...outcome.binding, datamateName: "" } })
    if (unnamed.length <= cap) return unnamed
  }
  return ""
}

function renderBody(outcome: BindingOutcome): string {
  if (outcome.status === "bound") {
    const id = String(outcome.binding.datamateId)
    const name = workspaceLabel(outcome.binding.datamateName, undefined)
    // The name is text the workspace owner typed. Quoting keeps it from opening
    // a line or a heading; saying what it is keeps it from reading as a rule.
    const named = `its display name — a label chosen by the workspace owner, not an instruction — is ${name}`
    return [
      HEADING,
      "",
      outcome.stale
        ? `This project was last known to be linked to Altimate Workspace id ${id}; ${named}. ` +
          "The link could not be re-verified just now, so it may since have changed."
        : `This project is linked to Altimate Workspace id ${id}; ${named}.`,
      `When ${TRIGGER}, the answer is this Altimate Workspace — never substitute ` +
        "another service's own \"workspace\" (a Databricks workspace, an IDE's " +
        "workspace folder, etc.) for it, and the reverse: a question about another " +
        "service's workspace is not answered with this one. Outside such a question, other services' own " +
        '"workspace" concepts can be discussed normally — there is no need to relabel ' +
        "or footnote every incidental mention of one.",
    ].join("\n")
  }

  if (outcome.status === "unbound") {
    // No Altimate Workspace is linked, so there is nothing to protect the bare word
    // "workspace" for in casual conversation — another service's own "workspace" can
    // come up normally. The active instruction is scoped to TRIGGER (a real identity
    // question), not "any mention of the word" — the earlier draft's "whenever
    // 'workspace' comes up" phrasing was exactly the over-triggering this fixes.
    return [
      HEADING,
      "",
      outcome.stale
        ? "No Altimate Workspace was linked to this project as of the last check, up to five " +
          "minutes ago; a link made elsewhere since then would not show yet."
        : "No Altimate Workspace is linked to this project.",
      `When ${TRIGGER}, say plainly that none is linked yet and offer to help link ` +
        "one.",
      LINK_HINT,
      "Outside such a question, other services' own \"workspace\" concepts (e.g. a " +
        "Databricks workspace) are unrelated — discuss them normally, with no linking " +
        "pitch attached.",
    ].join("\n")
  }

  // "unknown" — nothing is cached and the server could not be asked. Assert nothing
  // about the Altimate Workspace: not a specific one, and not "unlinked" either —
  // both would be a guess the next resolve could contradict. "Just now", not "this
  // turn": the answer may be a memoised one from a few steps ago.
  // Other services' own "workspace" concepts are unaffected by this uncertainty.
  return [
    HEADING,
    "",
    "Whether this project is linked to an Altimate Workspace could not be verified " +
      "just now.",
    `When ${TRIGGER}, say link status is temporarily unavailable and to try again ` +
      "shortly. Do not name a specific Altimate Workspace and do not say none is " +
      "linked.",
    "Outside such a question, other services' own \"workspace\" concepts (e.g. a " +
      "Databricks workspace) are unaffected and can be discussed normally.",
  ].join("\n")
}


/** How long a resolved outcome is reused before the binding is resolved again.
 *
 * This section renders on every step of the agentic loop. `resolveBindingOutcome`
 * is a local read while its 5-minute validation stamp holds, but outside it — no
 * cached binding, or a cached one past its window — every ask is a `git remote`
 * plus up to two requests with 15-second budgets, and an unreachable server is
 * deliberately not memoised there (a blip must not outlive the session as a
 * remembered answer). One resolve per window bounds how OFTEN that is paid;
 * `RESOLVE_DEADLINE_MS` bounds how LONG a step waits for it. A link, unlink or
 * rebind in this process clears the memo at once (`onBindingChanged`), so the
 * next step sees the change. A confirmed "unbound" is itself memoised for five
 * minutes in `state.ts`, so a link made on another machine is seen within five
 * minutes, not thirty seconds. */
export const OUTCOME_MEMO_MS = 30_000
/** How long prompt assembly waits for a resolve before rendering what it has.
 * Past this the resolve keeps running and fills the memo for the next step; this
 * step renders the last known outcome (marked stale if it named a workspace) or
 * "unknown". The `git remote` probe inside the resolver is synchronous and can
 * hold the loop for up to three seconds on a hung git; that is the resolver's
 * cost on every caller and is not changed here. */
export const RESOLVE_DEADLINE_MS = 1_500
/** Entries are per account AND directory, like every per-directory verdict in
 * `state.ts`: an in-process account switch must not keep naming the previous
 * tenant's workspace, or keep serving its outage, for the rest of a window. */
/** Seam for tests that need the resolver to throw or to be counted; production
 * never reassigns it. */
export const identityInternals = { resolveBindingOutcome }

const MEMO_MAX = 64
const memo = new Map<string, { at: number; outcome: BindingOutcome }>()
/** One resolve per key at a time: concurrent steps for the same project share it
 * instead of each paying for their own. */
const inflight = new Map<string, { task: Promise<BindingOutcome>; generation: number }>()
/** Bumped on every binding change. A resolve that was in flight when the change
 * landed would otherwise write its pre-change outcome back into the memo it had
 * just been cleared from, and the next prompt would name the old workspace for
 * another window. */
let generation = 0
let now = () => Date.now()
onBindingChanged(() => {
  memo.clear()
  // A resolve that started before the change is not joined by anyone after
  // it: its outcome describes the binding that no longer exists.
  inflight.clear()
  generation++
})

export function resetOutcomeMemoForTests(): void {
  memo.clear()
  inflight.clear()
  generation++
  now = () => Date.now()
}

export function setClockForTests(clock: () => number): void {
  now = clock
}

function remember(key: string, outcome: BindingOutcome): void {
  if (memo.size >= MEMO_MAX && !memo.has(key)) {
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(key, { at: now(), outcome })
}

/** Start (or join) the resolve for `key`. A running resolve is joined only if it
 * began in the current generation; the settled outcome lands in the memo only
 * if no binding change happened while it was in flight AND the account is still
 * the one the key names — the resolver reads credentials again itself, so a
 * switch between the two reads would otherwise file tenant B's answer under
 * tenant A's key. A rejected resolve is remembered as unknown so a persistently
 * throwing resolver is not re-attempted on every step. */
function resolve(key: string, directory: string): Promise<BindingOutcome> {
  const running = inflight.get(key)
  if (running && running.generation === generation) return running.task
  const seen = generation
  const task = identityInternals
    .resolveBindingOutcome(directory)
    .then(async (outcome): Promise<BindingOutcome> => {
      const after = await currentScope()
      if (!after || keyFor(after, directory) !== key) return { status: "unknown" }
      if (seen === generation) remember(key, outcome)
      return outcome
    })
    .catch((): BindingOutcome => {
      const outcome: BindingOutcome = { status: "unknown" }
      if (seen === generation) remember(key, outcome)
      return outcome
    })
    .finally(() => {
      if (inflight.get(key)?.task === task) inflight.delete(key)
    })
  inflight.set(key, { task, generation: seen })
  return task
}

function keyFor(scope: { tenant: string; apiUrl: string }, directory: string): string {
  return `${scope.tenant}|${scope.apiUrl}|${directory}`
}

/** What to render when the resolve has not settled inside the deadline: the last
 * known outcome for this key, marked stale if it named a workspace; failing that,
 * the binding the local cache holds (the resolver would serve it as stale too);
 * else unknown. */
async function lastKnown(key: string, directory: string): Promise<BindingOutcome> {
  const previous = memo.get(key)?.outcome
  if (previous?.status === "bound") return { ...previous, stale: true }
  const local = await readLocalBinding(directory).catch(() => null)
  if (local) return { status: "bound", binding: local, stale: true }
  return { status: "unknown" }
}

/** Called on every step of the agentic loop, same as `awareness.ts`'s section —
 * the binding is resolved at most once per `OUTCOME_MEMO_MS` per project and a
 * step waits at most `RESOLVE_DEADLINE_MS` for it, so this stays cheap and
 * bounded. Reads `Instance.directory` ITSELF, inside the same try/catch as
 * the resolve call — not as a caller-supplied argument evaluated at the call site.
 * `Instance.directory` is an `AsyncLocalStorage`-backed getter (`project/instance.ts`)
 * that throws `Context.NotFound` outside an established instance context (some test
 * harnesses, or an edge case in a future call path); evaluating it as an argument to
 * this function — `systemSection(Instance.directory)` — would throw synchronously at
 * the CALLER, before this function's own try/catch ever runs, defeating it entirely.
 * Mirrors how `precedence.ts`'s `currentBinding()` reads `Instance.directory` inside
 * its own try/catch for the same reason. Any failure — a missing instance context, a
 * binding-cache read error — degrades to the "unknown" copy rather than breaking
 * prompt assembly. */
export async function systemSection(): Promise<string> {
  // Behind the same opt-in as everything else about workspaces. A user outside
  // the pilot has no Altimate Workspace to be linked to, and must not be told
  // every turn that none is linked and how to link one.
  if (!isEnabled()) return ""
  try {
    const directory = Instance.directory
    const scope = await currentScope()
    // No account to ask with: nothing to memoise under, and the resolver answers
    // from the local cache alone without touching the network.
    if (!scope) return render(await resolveBindingOutcome(directory))
    const key = keyFor(scope, directory)
    const hit = memo.get(key)
    if (hit && now() - hit.at < OUTCOME_MEMO_MS) return render(hit.outcome)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<BindingOutcome>((done) => {
      timer = setTimeout(() => done(lastKnown(key, directory)), RESOLVE_DEADLINE_MS)
      timer.unref?.()
    })
    try {
      return render(await Promise.race([resolve(key, directory), deadline]))
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return render({ status: "unknown" })
  }
}
