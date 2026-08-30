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

/**
 * Render the section, or "" when there is nothing to steer.
 *
 * Pure projection of the snapshot `Precedence.refresh` stored for this turn — the same
 * object the tool descriptions were built from and that `check()` will read mid-turn.
 * One snapshot, one truth: the section cannot advertise a routing the guard would not
 * perform.
 *
 * Called once per STEP, not per turn: the prompt loop reassembles the system array on
 * every generation, so a 40-tool-call turn renders this 40 times. Kept cheap and
 * allocation-light for that reason, and deliberately not memoised — the snapshot is
 * re-derived per turn and a cached section outliving its snapshot would advertise
 * routing that no longer holds.
 */
/** What a non-routing session is told, keyed on the union so a new `disabledReason`
 * is a compile error here rather than silently rendering nothing. Only the escape
 * hatch speaks: the others mean "no routing to describe", and the toast layer already
 * tells the human why. */
const DISABLED_COPY: Record<NonNullable<Precedence["disabledReason"]>, string> = {
  "pilot-off": "",
  "escape-hatch": ESCAPE_HATCH_SECTION,
  unbound: "",
  unattributed: "",
  "nothing-materialised": "",
}

export function systemSection(precedence: Precedence | undefined): string {
  if (!precedence) return ""
  if (!precedence.enabled) return precedence.disabledReason ? DISABLED_COPY[precedence.disabledReason] : ""

  const served = servedInventory(precedence)
  if (served.length === 0) return ""

  const typeLines = served.map(({ type, served: rows, local }) => {
    const servedPart = rows.map((r) => `${CAPABILITY_LABEL[r.capability]}: \`${r.modelKey}\``).join("; ")
    const localPart = local.length
      ? ` (${local.map((c) => CAPABILITY_LABEL[c]).join(" and ")} for ${type} stay on the local ` +
        `${local.map(localToolOf).join(" / ")})`
      : ""
    return `- ${type} — ${servedPart}${localPart}`
  })

  return assemble(precedence.workspaceName, typeLines)
}

/** Build the section from its type lines, enforcing the char cap by dropping trailing
 * types rather than truncating mid-sentence. The converse paragraph is never dropped:
 * without it the section reads as "prefer the workspace for everything", which is the
 * over-steering failure this design most needs to avoid. */
function assemble(workspaceName: string, typeLines: string[]): string {
  const render = (lines: string[]) => {
    const omitted = typeLines.length - lines.length
    return [
      HEADING,
      "",
      `This project is bound to Altimate workspace "${workspaceName}". For the connection types ` +
        "listed below the local tools will NOT execute — they return a redirect. Call the workspace " +
        "tool directly:",
      "",
      ...lines,
      ...(omitted > 0
        ? [`- …and ${omitted} further connection type${omitted === 1 ? "" : "s"} served by this workspace.`]
        : []),
      "",
      `Every other connection type uses the local tools (${ALL_LOCAL_TOOLS}). Do not use ` +
        "`datamate_*` warehouse tools for connection types that are not listed above.",
    ].join("\n")
  }

  let lines = typeLines
  let out = render(lines)
  while (out.length > MAX_SECTION_CHARS && lines.length > 1) {
    lines = lines.slice(0, -1)
    out = render(lines)
  }
  return out
}
// altimate_change end
