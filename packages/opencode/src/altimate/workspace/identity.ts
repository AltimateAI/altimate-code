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
import { resolveBindingOutcome, type BindingOutcome } from "./state"
import { inertWorkspaceName } from "./workspace-name"
import { isEnabled } from "./engine-seams"
import { Instance } from "../../project/instance"

/** Independent of `awareness.ts`'s MAX_SECTION_CHARS (2,000) — this section is a short,
 * fixed-shape identity statement, not an open-ended list of served integrations, so a
 * much smaller ceiling is enough. Exists mainly as a guard against a pathological
 * workspace name defeating `inertWorkspaceName`'s own 80-code-point cap. */
export const MAX_SECTION_CHARS = 800

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
export function render(outcome: BindingOutcome): string {
  return capSection(renderBody(outcome))
}

/** Exported so the cap's own contract has direct coverage — `inertWorkspaceName`
 * already bounds the one variable input (the workspace name) to 80 code points, so no
 * real `render()` call can currently produce output long enough to exercise this via
 * `render()` alone. It stays as defense in depth against a future branch that adds
 * unbounded text. */
export function capSection(out: string): string {
  return out.length > MAX_SECTION_CHARS ? out.slice(0, MAX_SECTION_CHARS) : out
}

function renderBody(outcome: BindingOutcome): string {
  if (outcome.status === "bound") {
    const label = workspaceLabel(outcome.binding.datamateName, String(outcome.binding.datamateId))
    return [
      HEADING,
      "",
      `This project is linked to Altimate Workspace ${label}.`,
      `When ${TRIGGER}, the answer is this Altimate Workspace — never substitute ` +
        "another service's own \"workspace\" (a Databricks workspace, an IDE's " +
        "workspace folder, etc.) for it. Outside such a question, other services' own " +
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
      "No Altimate Workspace is linked to this project.",
      `When ${TRIGGER}, say plainly that none is linked yet and offer to help link ` +
        "one.",
      LINK_HINT,
      "Outside such a question, other services' own \"workspace\" concepts (e.g. a " +
        "Databricks workspace) are unrelated — discuss them normally, with no linking " +
        "pitch attached.",
    ].join("\n")
  }

  // "unknown" — the local cache and the server disagree, or neither is reachable this
  // turn. Assert nothing about the Altimate Workspace: not a specific one, and not
  // "unlinked" either — both would be a guess the next revalidation could contradict.
  // Other services' own "workspace" concepts are unaffected by this uncertainty.
  return [
    HEADING,
    "",
    "Whether this project is linked to an Altimate Workspace could not be verified " +
      "this turn.",
    `When ${TRIGGER}, say link status is temporarily unavailable and to try again ` +
      "shortly. Do not name a specific Altimate Workspace and do not say none is " +
      "linked.",
    "Outside such a question, other services' own \"workspace\" concepts (e.g. a " +
      "Databricks workspace) are unaffected and can be discussed normally.",
  ].join("\n")
}

function workspaceLabel(name: string, id: string): string {
  // A name that sanitises to nothing must not erase the identity: the id is the
  // stable half, and `""` reads as a bug.
  return `${JSON.stringify(inertWorkspaceName(name) || "(unnamed)")} (id ${id})`
}

/** Called on every step of the agentic loop, same as `awareness.ts`'s section —
 * `resolveBindingOutcome` is a cached local read (5-minute revalidation window), so
 * this stays cheap. Reads `Instance.directory` ITSELF, inside the same try/catch as
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
    const outcome = await resolveBindingOutcome(Instance.directory)
    return render(outcome)
  } catch {
    return render({ status: "unknown" })
  }
}
// altimate_change end
