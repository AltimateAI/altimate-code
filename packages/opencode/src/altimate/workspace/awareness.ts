// altimate_change start — workspace tool awareness.
//
// The model-facing half of workspace precedence. `precedence.ts` decides which calls
// are routed to the bound workspace's engine and REFUSES the ones that are; this
// module tells the model that up front, so it calls the engine tool first instead of
// learning the rule by being refused.
//
// Why a system-prompt section and not a richer tool description: `session/system.ts`
// records, from this repo's own benchmark trace analysis, that a lazily-described
// capability fired in "<1% of tool calls", and that guidance placed at the END of a
// section was "treated as background reference rather than binding directive" while
// the same content placed FIRST was applied. The precedence suffix appended by
// `describeNativeTool` is exactly that shape — trailing, non-imperative, and it never
// names the engine key — which is why it did not change behaviour.
//
// PURELY ADDITIVE BY CONSTRUCTION. This module renders a string and nothing else. It
// has no effect on which calls are shadowed, on what a shadowed call returns, or on
// any tool body. Its one safety property is that it returns "" in every state except
// a bound, attributed workspace with materialised engine tools — so a session without
// a bound workspace assembles a byte-identical system prompt to before this shipped.
//
// SERVER-SIDE ONLY, for the same reason `precedence.ts` is: the TUI plugin runtime
// loads plugins in a separate module realm, so an import from there would read a
// different, always-empty `Precedence` map. Import this only from the session layer.
import { type Capability, type Precedence, servedInventory } from "./precedence"

/** Hard ceiling on the rendered section. Deliberately independent of
 * `UNIFIED_INJECTION_BUDGET`: this is a routing directive, not knowledge, and must
 * never compete with memory for space. Four integrations x three capabilities lands
 * far under this; the cap exists so a future engine advertising many integrations
 * degrades predictably instead of crowding the prompt. */
export const MAX_SECTION_CHARS = 2_000

const HEADING = "## Workspace integrations"

/** How each capability is named to the model. Keyed on the `Capability` union, so a
 * new capability is a compile error here rather than an unlabelled row. */
const CAPABILITY_LABEL: Record<Capability, string> = {
  sql_execute: "execute",
  sql_explain: "explain plan",
  schema_inspect: "table stats / schema inspection",
}

/** The `Capability` union IS the native tool id — `describeNativeTool` relies on the
 * same identity (`precedence.ts`, `(CAPABILITIES as string[]).includes(toolID)`), so
 * there is no separate mapping to keep in step. */
const localToolOf = (c: Capability) => `\`${c}\``

/** Derived, never hand-written: `CAPABILITY_LABEL` is exhaustive over `Capability`,
 * so a new capability updates this list by construction. A literal here would go
 * stale silently and tell the model an incomplete set of local tools — the exact
 * over-steering the converse paragraph exists to prevent. */
const ALL_LOCAL_TOOLS = (Object.keys(CAPABILITY_LABEL) as Capability[]).map(localToolOf).join(", ")

/** Said when the escape hatch is on. Engine tools can still materialise in that
 * session — `derive` refuses before it looks at them, but the MCP client connects the
 * configured entry regardless — so silence here would leave the model free to reach
 * for tools it can see and should not use. */
const ESCAPE_HATCH_SECTION = [
  HEADING,
  "",
  "Workspace routing is disabled for this session (`--integrations=local`). Use the local " +
    `warehouse tools (${ALL_LOCAL_TOOLS}) for every connection, even if \`datamate_*\` tools ` +
    "are present in this catalog.",
].join("\n")

/** Said when routing is off because the engine could not be verified — the binding
 * unreadable, the engine not attributable to the bound workspace, or the derivation
 * failed. `check()` fails open in those states and the engine's tools may still be in
 * the catalog (under `unattributed` they may belong to a DIFFERENT workspace, which is
 * why routing refused them), so the model is steered to the local tools the same way
 * the hatch does. The workspace is not named: nothing here has verified it. */
const UNVERIFIED_SECTION = [
  HEADING,
  "",
  "Workspace routing is not active for this session: the bound workspace's engine could not " +
    `be verified. Use the local warehouse tools (${ALL_LOCAL_TOOLS}) for every connection, even ` +
    "if `datamate_*` tools are present in this catalog.",
].join("\n")

/** What a non-routing session is told, keyed on the union so a new `disabledReason`
 * is a compile error here rather than silently rendering nothing. Silence is reserved
 * for the states where there is nothing the model could misuse: the pilot off, no
 * binding, or no engine tools materialised. Those keep the system prompt byte-identical
 * to before this module existed. */
const DISABLED_COPY: Record<NonNullable<Precedence["disabledReason"]>, string> = {
  "pilot-off": "",
  "escape-hatch": ESCAPE_HATCH_SECTION,
  unbound: "",
  "binding-unreadable": UNVERIFIED_SECTION,
  unattributed: UNVERIFIED_SECTION,
  "derive-failed": UNVERIFIED_SECTION,
  "nothing-materialised": "",
}

/**
 * Render the section, or "" when there is nothing to steer.
 *
 * Pure projection of the snapshot `Precedence.refresh` stored for this turn — the same
 * object the tool descriptions were built from and that `check()` will read mid-turn.
 * One snapshot, one truth: the section cannot advertise a routing the guard would not
 * perform. (The exposed tool list is pinned to the turn's first catalog while this
 * snapshot is refreshed per step, so on a later step the two can name different
 * engine keys if another session replaced the engine mid-turn — the lease work that
 * pins the raw tool map closes that, not this module.)
 *
 * Called once per STEP, not per turn: the prompt loop reassembles the system array on
 * every generation, so a 40-tool-call turn renders this 40 times. Kept cheap and
 * allocation-light for that reason, and deliberately not memoised — the snapshot is
 * refreshed per step, ahead of this render, and a cached section outliving its
 * snapshot would advertise routing that no longer holds.
 */
export function systemSection(precedence: Precedence | undefined): string {
  if (!precedence) return ""
  if (!precedence.enabled) return precedence.disabledReason ? DISABLED_COPY[precedence.disabledReason] : ""

  const served = servedInventory(precedence)
  if (served.length === 0) return ""

  // `type` is the canonical local driver type (`postgres`), not the user-facing
  // connection name nor the engine's integration id (`postgresql`) — it is what the
  // local connection registry carries, so it is what the model must match against.
  const typeLines = served.map(({ type, served: rows, local }) => {
    const servedPart = rows.map((r) => `${CAPABILITY_LABEL[r.capability]}: \`${r.modelKey}\``).join("; ")
    const localPart = local.length
      ? ` (${local.map((c) => CAPABILITY_LABEL[c]).join(" and ")} for ${type} stay on the local ` +
        `${local.map(localToolOf).join(" / ")})`
      : ""
    return `- ${type} — ${servedPart}${localPart}`
  })

  return assemble(precedence.workspaceName, precedence.workspaceId, typeLines)
}

/** The workspace name is customer-authored and lands in the system prompt — the
 * highest-trust surface there is. Emitted as inert data: control characters stripped,
 * whitespace collapsed, length bounded, then JSON-quoted so quotes, newlines and
 * Markdown cannot break out of the sentence. The numeric id, when known, is the
 * stable identifier and is named alongside. */
const MAX_NAME_CHARS = 80
function workspaceLabel(name: string, id: string | undefined): string {
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const bounded = cleaned.length > MAX_NAME_CHARS ? cleaned.slice(0, MAX_NAME_CHARS - 1) + "…" : cleaned
  return id ? `${JSON.stringify(bounded)} (id ${id})` : JSON.stringify(bounded)
}

/** Build the section from its type lines, enforcing the char cap by dropping trailing
 * types rather than truncating mid-sentence — down to none if a single line is
 * oversized, so the ceiling is a real one. The converse paragraph is never dropped:
 * without it the section reads as "prefer the workspace for everything", which is the
 * over-steering failure this design most needs to avoid. It changes shape when types
 * were omitted, though: the omitted types ARE served, so forbidding `datamate_*` for
 * "types not listed" would contradict the omission line — the partial list is said to
 * be partial instead, and the prohibition is kept only for types the workspace does
 * not serve. */
function assemble(workspaceName: string, workspaceId: string | undefined, typeLines: string[]): string {
  const label = workspaceLabel(workspaceName, workspaceId)
  const render = (lines: string[]) => {
    const omitted = typeLines.length - lines.length
    const converse =
      omitted > 0
        ? `This list is partial: ${omitted} further connection type${omitted === 1 ? " is" : "s are"} served by this ` +
          "workspace and omitted for length; for those, prefer the `datamate_*` tool for that type when one is in the " +
          `catalog. Connection types this workspace does not serve use the local tools (${ALL_LOCAL_TOOLS}).`
        : `Every other connection type uses the local tools (${ALL_LOCAL_TOOLS}). Do not use ` +
          "`datamate_*` warehouse tools for connection types that are not listed above."
    return [
      HEADING,
      "",
      `This project is bound to Altimate workspace ${label}. For each connection type below, the ` +
        "local tool for a capability that names a workspace tool will NOT execute — it returns a " +
        "redirect. Call the named workspace tool directly; capabilities not named for a type stay on " +
        "the local tools:",
      "",
      ...lines,
      ...(omitted > 0
        ? [`- …and ${omitted} further connection type${omitted === 1 ? "" : "s"} served by this workspace.`]
        : []),
      "",
      converse,
    ].join("\n")
  }

  let lines = typeLines
  let out = render(lines)
  while (out.length > MAX_SECTION_CHARS && lines.length > 0) {
    lines = lines.slice(0, -1)
    out = render(lines)
  }
  return out
}
// altimate_change end
