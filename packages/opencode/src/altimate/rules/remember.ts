// altimate_change - new file
//
// "Remember …" in a project linked to a workspace: the person's request decides between memory and a team rule,
// whichever save tool the agent reached for. `training_save` (kind rule) and `altimate_memory_write` (project scope,
// when the person asked to remember) both come here first.

/** The person asked for something to be remembered (not the agent deciding to take a note). */
const ASKED_TO_REMEMBER = /\b(?:remember|don'?t forget|do not forget|keep in mind|note (?:that|this)|save (?:this|that)|from now on)\b/i
/** The text of the person's latest message in the session. */
export function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { info?: { role?: string }; parts?: { type?: string; text?: string; synthetic?: boolean }[] }
    if (message?.info?.role !== "user") continue
    const text = (message.parts ?? []).filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text ?? "").join(" ").trim()
    if (text) return text
  }
  return undefined
}

/**
 * In a linked project with rules enabled, show the proposal card for `content` instead of saving it, and return the
 * tool result that tells the agent so. Undefined means "not a card: save as the tool normally would".
 * `via: "memory"` (the agent chose the memory tool): only when the person's own message asked to remember something,
 * and only when it does not read as a memory; then the card (team rule, or "Memory · Team rule · Skip" when unclear)
 * replaces the memory write, so the person decides, not the agent's tool choice.
 */
export async function proposeTeamRule(content: string, sessionID: string, said?: string, via: "training" | "memory" = "training") {
  const [{ Instance }, { Config }] = await Promise.all([import("../../project/instance"), import("@/config/config")])
  const root = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
  return proposeFor({ root, directory: Instance.directory, learn: (await Config.get()).learn, content, sessionID, said, via })
}

/** `proposeTeamRule` for an explicit project (`root`, `directory`) and learn config. */
export async function proposeFor(input: {
  root: string
  directory: string
  learn: { enabled?: boolean; capture?: boolean } | undefined
  content: string
  sessionID: string
  said?: string
  via?: "training" | "memory"
}) {
  const { root, learn, content, sessionID, said } = input
  const via = input.via ?? "training"
  if (via === "memory" && !(said && ASKED_TO_REMEMBER.test(said))) return undefined
  const [{ RulesStore }, { RuleTrigger }, { RulesSync }] = await Promise.all([
    import("./store"),
    import("./trigger"),
    import("./sync"),
  ])
  // With learning or workspaces off, nothing would ever send the card: save it locally as before.
  if (!RulesSync.rulesEnabled(learn)) return undefined
  const state = await RulesStore.read(root)
  if (!state.scope || !state.workspace) return undefined
  const result = await RuleTrigger.explicit({ sessionID, root, directory: input.directory, learn, text: content, said })
  const metadata = { action: "proposed" as string, kind: "rule", name: "", scope: "project" }
  // From the memory tool, a memory (or a text that can't be a one-line rule) is simply saved as asked.
  if (via === "memory" && (result.status === "memory" || result.status === "invalid")) return undefined
  if (result.status === "memory")
    return {
      title: "Not a team rule",
      metadata: { ...metadata, action: "redirect" },
      output: `This reads as ${result.cue}, not a team rule. Save it with altimate_memory_write instead (scope "global" for a personal preference, "project" for a fact about this project), then tell the person it was saved to memory.`,
    }
  if (result.status === "invalid")
    return {
      title: "Team rule: not proposed",
      metadata: { ...metadata, action: "error" },
      output: `Not proposed: a team rule must be one line of at most 140 characters with no commands, links or secrets (${result.reason}). Restate it as one short line and call training_save again.`,
    }
  const owner = state.workspace.is_owner ? "you (the workspace owner)" : (state.workspace.owner_name ?? "the workspace owner")
  return {
    title: `Team rule proposed: "${content.slice(0, 60)}"`,
    metadata,
    output: [
      result.choose
        ? `The person sees a card asking whether to save this as a memory (just for them, applies now) or as a team rule for ${state.workspace.name} (goes to ${owner} for review), or to skip it.`
        : `Proposed as a team rule for ${state.workspace.name}. The person sees a card to ` +
          (state.workspace.is_owner ? "approve it now" : `send it to ${owner} for review`) + ", edit the wording, or decline.",
      via === "memory"
        ? "Nothing was saved yet: the person chooses on the card. Do not save it again with altimate_memory_write or training_save; follow it for the rest of this session."
        : "Follow the rule for the rest of this session. Do not save it again, and do not say it is already a team rule: it applies to teammates only after approval.",
    ].join("\n"),
  }
}

export * as RulesRemember from "./remember"
