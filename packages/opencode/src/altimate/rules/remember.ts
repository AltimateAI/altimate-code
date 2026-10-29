// altimate_change - new file
//
// "Remember …" in a project linked to a workspace: the person's request decides between memory and a team rule,
// whichever save tool the agent reached for. `training_save` (kind rule) and `altimate_memory_write` (project scope,
// when the person asked to remember) both come here first.

import fs from "node:fs/promises"

/** The person asked for something to be remembered (not the agent deciding to take a note). */
const ASKED_TO_REMEMBER = /\b(?:remember|don'?t forget|do not forget|keep in mind|note (?:that|this)|save (?:this|that)|from now on)\b/i
const contentWords = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])
const NEGATION = /\b(?:never|not|no|don'?t|do not|avoid|without)\b/i

/** Does `content` restate what the person said? Most of its words appear in their message, and it does not drop or add
 * a negation ("never use FLOAT" is not restated by "use FLOAT"). */
export function restates(content: string, said: string): boolean {
  const words = [...contentWords(content)]
  if (!words.length) return false
  if (NEGATION.test(content) !== NEGATION.test(said)) return false
  const spoken = contentWords(said)
  return words.filter((word) => spoken.has(word)).length / words.length >= 0.6
}

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
export async function proposeTeamRule(
  content: string,
  sessionID: string,
  said?: string,
  via: "training" | "memory" = "training",
  memory?: { id: string; tags: string[] },
  /** From `training_save`: the entry it meant to write, saved as such if the card closes unanswered. */
  training?: { name: string; source?: string; citations?: import("../../memory/types").MemoryBlock["citations"] },
) {
  const [{ Instance }, { Config }, { RulesService }] = await Promise.all([
    import("../../project/instance"),
    import("@/config/config"),
    import("./service"),
  ])
  // Canonical, like the after-turn path (`service.ts`): a card is deduplicated by root, and a symlinked checkout or
  // `/var` → `/private/var` would otherwise show the same rule twice.
  const raw = Instance.worktree !== "/" ? Instance.worktree : Instance.directory
  const root = await fs.realpath(raw).catch(() => raw)
  // The project's learn file as it is now, like every other entry point: `learn disable` mid-session takes effect.
  const learn = await RulesService.effectiveLearn((await Config.get()).learn, root, Instance.directory)
  // A subagent's session is not the one a client shows: its card would never be seen.
  const subagent = await import("@/session")
    .then(async ({ Session }) => {
      const { SessionID } = await import("@/session/schema")
      return !!(await Session.get(SessionID.make(sessionID))).parentID
    })
    .catch(() => false)
  // Bound to this instance, so it saves into this project whenever the card closes unanswered.
  const unanswered = Instance.bind(async (text: string) => {
    const now = new Date().toISOString()
    if (via === "memory" && memory) {
      const { MemoryStore } = await import("../../memory/store")
      await MemoryStore.write({ id: memory.id, scope: "project", tags: memory.tags, created: now, updated: now, content: text }, { sessionID })
      return
    }
    const [{ TrainingStore }, { RuleProposal }] = await Promise.all([import("../training"), import("./proposal")])
    await TrainingStore.save({
      kind: "rule",
      name: training?.name ?? RuleProposal.slug(text),
      scope: "project",
      content: text,
      source: training?.source ?? "remember (card closed unanswered)",
      ...(training?.citations ? { citations: training.citations } : {}),
      sessionID,
    })
  })
  return proposeFor({ root, directory: Instance.directory, learn, content, sessionID, said, via, memory, subagent, unanswered })
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
  /** From the memory tool: the block it meant to write, used if the person picks Memory on the card. */
  memory?: { id: string; tags: string[] }
  /** The session is a subagent's: no client shows its cards. */
  subagent?: boolean
  /** Saves the request as before cards if its card closes unanswered. */
  unanswered?: (text: string) => Promise<void>
}) {
  const { root, learn, content, sessionID, said } = input
  const via = input.via ?? "training"
  // From the memory tool, only the thing the person asked to remember gets a card: their message decides rule or
  // memory for that text, not for an unrelated note the agent saves in the same turn.
  if (via === "memory" && !(said && ASKED_TO_REMEMBER.test(said) && restates(content, said))) return undefined
  const [{ RulesStore }, { RuleTrigger }, { RulesSync }, { RulesTelemetry }] = await Promise.all([
    import("./store"),
    import("./trigger"),
    import("./sync"),
    import("./telemetry"),
  ])
  // With learning or workspaces off, nothing would ever send the card: save it locally as before.
  if (!RulesSync.rulesEnabled(learn)) return void RulesTelemetry.routed(sessionID, via, "learning_off")
  const state = await RulesStore.read(root)
  if (!state.scope || !state.workspace) return void RulesTelemetry.routed(sessionID, via, "not_linked")
  // Nothing attached to this process shows cards (`altimate-code run`, ACP, a plugin): a card would be lost, so the
  // tool saves as it did before cards (memory, or project training).
  const { RuleProposal } = await import("./proposal")
  if (input.subagent || !RuleProposal.rendererAttached(input.directory)) return void RulesTelemetry.routed(sessionID, via, "no_renderer")
  const result = await RuleTrigger.explicit({ sessionID, root, directory: input.directory, learn, text: content, said, memory: input.memory, unanswered: input.unanswered })
  RulesTelemetry.routed(
    sessionID,
    via,
    result.status === "shown" ? (result.choose ? "choose_card" : "card") : result.status,
  )
  const metadata = { action: "proposed" as string, kind: "rule", name: "", scope: "project" }
  // From the memory tool, a memory is simply saved as asked; so is a long note that did not ask to be a rule. A
  // requested rule that is not one line is sent back to be restated: saved as project memory, it would reach
  // teammates through the workspace's memory without review.
  if (via === "memory" && (result.status === "memory" || (result.status === "invalid" && result.kind !== "rule"))) return undefined
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
      output: `Not proposed: a team rule must be one line of at most 140 characters with no commands, links or secrets (${result.reason}). Restate it as one short line and save it again.`,
    }
  const owner = state.workspace.is_owner ? "you (the workspace owner)" : (state.workspace.owner_name ?? "the workspace owner")
  return {
    title: result.choose ? `Team rule or memory: "${content.slice(0, 60)}"` : `Team rule proposed: "${content.slice(0, 60)}"`,
    metadata,
    output: [
      result.choose
        ? `The person sees a card asking whether to save this as a memory (just for them, applies now) or as a team rule for ${state.workspace.name} (goes to ${owner} for review), or to skip it.`
        : `Proposed as a team rule for ${state.workspace.name}. The person sees a card to ` +
          (state.workspace.is_owner ? "approve it now" : `send it to ${owner} for review`) + ", edit the wording, or decline.",
      via === "memory"
        ? "Nothing was saved yet: the person chooses on the card (if they never answer, it is saved to this project's memory when the card closes). Do not save it again with altimate_memory_write or training_save; follow it for the rest of this session."
        : "Follow the rule for the rest of this session. Do not save it again, and do not say it is already a team rule: it applies to teammates only after approval (if the card is never answered, it is saved as a rule for this project when it closes).",
    ].join("\n"),
  }
}

export * as RulesRemember from "./remember"
