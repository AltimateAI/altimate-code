// altimate_change - new file
//
// Workspace rules in the TUI: a thin renderer of the session server's rule events.
//
// - The proposed-rule card, inline above the session's input (the `session_prompt` slot, which renders the
//   regular input below it): renders `rule.proposal.asked` (and `.updated` after an edit) and answers with
//   `POST /rule-proposal/:id/reply`. Typing is never blocked. `<leader>p` (or a click) focuses the card; then
//   Enter takes the selected action (first: send for review for a member, approve now for the owner or an admin), `e` edits
//   the wording, `n` is "Not a rule", Escape goes back to typing and leaves the card. When the wording did not
//   say rule or memory, the card asks "Memory · Team rule · Skip". Open proposals load at startup, so a card
//   asked before this TUI subscribed still shows; one answered in another client disappears.
// - Review notices: `rule.proposal.reviewed` becomes a toast ("approved", or "rejected" with the reason), for a rule or,
//   with `kind`, for a skill or knowledge base the person submitted to the workspace.
// - `/rules`: the team rules, your proposals with their status and reasons, Sync now, and learning on/off.
//
// No rule logic lives here; the IDE extension renders the same events and calls the same routes.
import { TextAttributes } from "@opentui/core"
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createEffect, createRoot, createSignal, onCleanup, Show } from "solid-js"
import type { ProposalCard } from "@/altimate/rules/events"
import { RuleClassify } from "@/altimate/rules/classify"
import { printable } from "@/altimate/rules/printable"
import type { RulesSummary } from "@/altimate/rules/summary"
import { describeAge } from "@/altimate/workspace/attach-snapshot"
import { WorkspaceRole } from "@/altimate/workspace/role"

const id = "altimate:rules"

type Raw = {
  post(input: { url: string; body?: unknown; headers?: Record<string, string> }): Promise<{ data?: unknown; error?: unknown }>
  get(input: { url: string }): Promise<{ data?: unknown; error?: unknown }>
}
type ReplyResult = { ok: boolean; message?: string; error?: string; card?: ProposalCard }

function raw(api: TuiPluginApi): Raw | undefined {
  return (api.client as unknown as { client?: Raw }).client
}

async function post<T>(api: TuiPluginApi, url: string, body?: unknown): Promise<T | undefined> {
  const client = raw(api)
  if (!client) return undefined
  const result = await client.post({ url, body: body ?? {}, headers: { "Content-Type": "application/json" } })
  return (result.data ?? (result.error as T | undefined)) as T | undefined
}

/** Who decides learning, as `/rules` says it. */
const sourceLabel = (source: string) =>
  source === "organization" ? "organization policy" : source === "you" ? "your setting" : source === "workspace" ? "workspace setting" : "default"

/** Events of this TUI's project only. A session server can host several projects, and the event stream carries every
 * project's events: a card, a review notice or a refresh for another project is not this one's (it would show another
 * project's skill name, reviewer and reason here). */
const on = (api: TuiPluginApi) => (type: string, handler: (event: { properties: any }) => void) =>
  (api.event.on as unknown as (type: string, handler: (event: { properties: any }, meta?: { directory?: string }) => void) => () => void)(
    type,
    (event, meta) => {
      if (meta?.directory && meta.directory !== api.state.path.directory) return
      handler(event)
    },
  )
const root = (api: TuiPluginApi) => (api.state.path.worktree && api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory)
type Summary = RulesSummary.Summary & { ok: boolean; line: string }
type Row = RulesSummary.RuleRow

async function get<T>(api: TuiPluginApi, url: string): Promise<T | undefined> {
  const result = await raw(api)?.get({ url }).catch(() => undefined)
  return result?.data as T | undefined
}

/** Rules state from the session server: the TUI may be attached to a server on another host or path, so it never
 * reads the rules files itself. */
async function summaryOf(api: TuiPluginApi): Promise<Summary | undefined> {
  const summary = await get<Summary>(api, "/altimate/rules/summary")
  return summary?.ok ? summary : undefined
}

function title(card: ProposalCard) {
  if (card.choose) return "SAVE THIS?"
  if (card.change === "edit") return "PROPOSED EDIT TO A TEAM RULE"
  if (card.change === "retire") return "PROPOSED: RETIRE A TEAM RULE"
  return card.workspace ? "PROPOSED TEAM RULE" : "PROPOSED RULE"
}

function meta(card: ProposalCard) {
  const parts = [card.applies_to.length ? `applies to ${printable(card.applies_to.join(", "))}` : "applies to the whole repository"]
  if (card.evidence.correction) parts.push(`from your correction ${describeAge(Date.parse(card.evidence.correction.at))}`)
  if (card.evidence.sessions > 1) parts.push(`seen in ${card.evidence.sessions} sessions`)
  parts.push(`${card.chars} chars`)
  return parts.join(" · ")
}

/** Where "Memory" saves, as the server decided (older servers did not say: the wording decides there too). */
const memoryScope = (card: ProposalCard) => card.memory_scope ?? RuleClassify.memoryScope(card.text)

/** Button labels, in the order shown. Enter on a fresh card takes the first: the team action, or "Memory" on a
 * "Save as" card. */
function buttons(card: ProposalCard): { action: ProposalCard["actions"][number]; label: string }[] {
  const label: Record<ProposalCard["actions"][number], string> = {
    send: card.choose ? "Team rule — send for review" : "Send for review",
    approve: card.choose ? "Team rule — approve now" : card.weakens_verification ? "Approve anyway" : "Approve now",
    save_local: "Save for this project",
    save_memory: memoryScope(card) === "global" ? "Memory — just for you" : "Memory — this project",
    edit: "Edit wording",
    dismiss: card.choose ? "Skip" : "Not a rule",
  }
  const order = ["save_memory", "send", "approve", "save_local", "edit", "dismiss"]
  return [...card.actions].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((action) => ({ action, label: label[action] }))
}

/** What the team action does, shown under the buttons while the card is focused. */
function explain(card: ProposalCard, action: string): string {
  const owner = card.workspace?.owner_name ? printable(card.workspace.owner_name) : "the workspace owner"
  const ws = card.workspace?.name ? printable(card.workspace.name) : "the workspace"
  if (action === "send") return `Goes to the review queue in ${ws} → Rules (${owner} or an admin decides). Nothing changes for the team until approved.`
  if (action === "approve")
    return `${card.workspace && WorkspaceRole.roleOf(card.workspace) === "admin" ? "You are an admin of" : "You own"} ${ws}: it reaches every teammate's sessions within a few minutes.`
  if (action === "save_local") return "Not linked to a workspace: saved as project training, no review."
  if (action === "save_memory")
    return memoryScope(card) === "global"
      ? "Your preference: saved to your memory now, for all your projects. No review."
      : "A fact about this project: saved to its memory now. Shared with the workspace if its memory sharing is on. Not a team rule."
  if (action === "edit") return "Change the text before deciding."
  return card.choose || !card.topics.length ? "Don't save anything." : "Won't propose this topic again for 30 days."
}

const FOCUS_KEY = "<leader>p"
const FOCUS_COMMAND = "altimate.rules.card.focus"

function InlineCard(props: {
  api: TuiPluginApi
  card: ProposalCard
  more: number
  focused: boolean
  selected: number
  /** "Approve anyway" was pressed once: say what a second Enter does. */
  confirming?: boolean
  onPick: (index: number) => void
  onFocus: () => void
}) {
  const theme = () => props.api.theme.current
  const card = () => props.card
  const options = () => buttons(card())
  // The key as configured (the leader can be rebound).
  const focusHint = () =>
    props.api.keys.formatSequence(
      props.api.keymap.getCommandBindings({ visibility: "registered", commands: [FOCUS_COMMAND] }).get(FOCUS_COMMAND)?.[0]?.sequence,
    ) || "ctrl+x p"
  return (
    <box
      backgroundColor={theme().backgroundPanel}
      border={["left"]}
      borderColor={props.focused ? theme().accent : card().weakens_verification ? theme().warning : theme().border}
      flexShrink={0}
      onMouseUp={() => props.onFocus()}
    >
      <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={0}>
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme().accent}>{title(card())}</text>
          <Show when={props.more > 0}>
            <text fg={theme().textMuted}>{`+${props.more} more`}</text>
          </Show>
        </box>
        <Show when={card().replaces && card().change === "edit"}>
          <text attributes={TextAttributes.STRIKETHROUGH} fg={theme().textMuted}>{printable(card().replaces!.text)}</text>
        </Show>
        <text fg={theme().text} attributes={card().change === "retire" ? TextAttributes.STRIKETHROUGH : undefined}>{printable(card().text)}</text>
        <text fg={theme().textMuted}>{meta(card())}</text>
        <Show when={props.focused && card().why}>
          <text fg={theme().textMuted}>{`Why: ${printable(card().why)}`}</text>
        </Show>
        <Show when={props.focused && card().evidence.correction}>
          <text fg={theme().textMuted}>{`Your correction: "${printable(card().evidence.correction!.excerpt)}"`}</text>
        </Show>
        <Show when={card().weakens_verification}>
          <text fg={theme().warning}>{`⚠ ${printable(card().weakens_verification)} — it needs "approve anyway"`}</text>
        </Show>
      </box>
      <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={props.focused ? 0 : 1} flexWrap="wrap">
        {options().map((option, index) => (
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.focused && index === props.selected ? theme().accent : theme().backgroundElement}
            onMouseUp={() => props.onPick(index)}
          >
            <text fg={props.focused && index === props.selected ? theme().background : theme().textMuted}>{option.label}</text>
          </box>
        ))}
        <Show when={!props.focused}>
          <text fg={theme().text}>
            {focusHint()} <span style={{ fg: theme().textMuted }}>review</span>
          </text>
        </Show>
      </box>
      <Show when={props.focused}>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" justifyContent="space-between" gap={3}>
          <text fg={props.confirming ? theme().warning : theme().textMuted}>
            {props.confirming
              ? "It weakens verification for every teammate. Press Enter again to approve anyway."
              : explain(card(), options()[props.selected]?.action ?? "")}
          </text>
          <text fg={theme().text}>
            {"⇆"} <span style={{ fg: theme().textMuted }}>select</span>  enter <span style={{ fg: theme().textMuted }}>confirm</span>
            {"  "}esc <span style={{ fg: theme().textMuted }}>back to typing</span>
          </text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Proposed-rule cards, inline above the session's input. Typing is never blocked: the card waits until the
 * person focuses it (`<leader>p` or a click), picks an action, or goes back to typing with Escape. One card
 * shows per session; the rest wait behind "+N more". Permission and question prompts hide it, as they hide
 * the input.
 */
function installCards(api: TuiPluginApi) {
  const [cards, setCards] = createSignal<ProposalCard[]>([])
  const [focused, setFocused] = createSignal(false)
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  /** The flagged card whose "Approve anyway" was pressed once and waits for a second Enter. */
  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  let prompt: TuiPromptRef | undefined
  let layer: (() => void) | undefined
  // The session whose input slot is mounted and visible now. Permission and question prompts hide the slot, and
  // home has none: the card (and its keys) exist only while this is set.
  const [active, setActive] = createSignal<string | undefined>(undefined)

  const current = () => {
    const sessionID = active()
    return sessionID ? cards().find((card) => card.sessionID === sessionID) : undefined
  }
  const remove = (id: string) => setCards((list) => list.filter((card) => card.id !== id))

  // The card's keys (enter, e, n, h, l, …) only while it is focused and no dialog is open: under a dialog they
  // would take the dialog's own keys (Enter in "Edit the rule" would re-run the card's selected action).
  const releaseKeys = () => {
    layer?.()
    layer = undefined
  }

  const unfocus = () => {
    setConfirming(undefined)
    releaseKeys()
    setFocused(false)
    prompt?.focus()
  }

  const reply = async (card: ProposalCard, action: string, text?: string) => {
    if (busy()) return
    setBusy(true)
    const result = await post<ReplyResult>(api, `/rule-proposal/${card.id}/reply`, { action, ...(text !== undefined ? { text } : {}) })
      .catch(() => undefined)
      .finally(() => setBusy(false))
    if (!result) return api.ui.toast({ variant: "error", message: "Could not reach the session server.", duration: 6000 })
    if (!result.ok) {
      // Closed on the server (expired, or its instance went away): it can't be answered, so it leaves the queue.
      if ((result as { code?: string }).code === "not_open") remove(card.id)
      return api.ui.toast({ variant: "error", message: printable(result.error ?? "Not done."), duration: 8000 })
    }
    if (action === "edit") {
      if (result.card) setCards((list) => list.map((c) => (c.id === card.id ? result.card! : c)))
      return
    }
    api.ui.toast({ variant: "success", message: printable(result.message ?? "Done."), duration: 6000 })
    remove(card.id)
    unfocus()
  }

  const edit = (card: ProposalCard) => {
    releaseKeys()
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogPrompt
          title="Edit the rule"
          description={() => <text fg={api.theme.current.textMuted}>One line, at most 140 characters.</text>}
          value={card.text}
          onConfirm={(text) => {
            api.ui.dialog.clear()
            void reply(card, "edit", text)
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ),
    )
  }

  const pick = (index: number) => {
    const card = current()
    const option = card && buttons(card)[index]
    if (!card || !option) return
    setSelected(index)
    if (option.action === "edit") return edit(card)
    // Approving a rule that weakens verification for the whole workspace takes a second Enter.
    if (option.action === "approve" && card.weakens_verification && confirming() !== card.id) {
      setConfirming(card.id)
      return
    }
    setConfirming(undefined)
    // The confirmed approval is its own action: a plain `approve` on a flagged card is refused by the server.
    void reply(card, option.action === "approve" && card.weakens_verification ? "approve_anyway" : option.action)
  }

  const shortcut = (action: string) => {
    const card = current()
    const index = card ? buttons(card).findIndex((b) => b.action === action) : -1
    if (index >= 0) pick(index)
  }

  const move = (step: number) => {
    const card = current()
    if (!card) return
    setConfirming(undefined)
    const count = buttons(card).length
    setSelected((index) => (index + step + count) % count)
  }

  const focus = () => {
    if (!active() || !current() || focused()) return
    setSelected(0)
    setFocused(true)
    prompt?.blur()
    bindKeys()
  }

  function bindKeys() {
    if (layer || api.ui.dialog.open || !active() || !current()) return
    layer = api.keymap.registerLayer({
      priority: 100,
      bindings: [
        { key: "left", cmd: () => move(-1) },
        { key: "h", cmd: () => move(-1) },
        { key: "right", cmd: () => move(1) },
        { key: "l", cmd: () => move(1) },
        { key: "tab", cmd: () => move(1) },
        { key: "return", cmd: () => pick(selected()) },
        { key: "e", cmd: () => shortcut("edit") },
        { key: "n", cmd: () => shortcut("dismiss") },
        { key: "escape", cmd: () => unfocus() },
      ],
    })
  }

  // A dialog opened while the card is focused (the edit prompt, the palette, `/rules`) takes the keys, and the card
  // leaves focus: when the dialog closes the host gives focus back to the prompt, so re-binding the card's keys then
  // would take Enter, `e` and `n` from whatever the person types next. `<leader>p` focuses the card again.
  const disposeEffects = createRoot((dispose) => {
    createEffect(() => {
      if (!api.ui.dialog.open || !focused()) return
      releaseKeys()
      setConfirming(undefined)
      setFocused(false)
    })
    // The card left the screen (a prompt hid the input, another session, home) or its card went away: give the keys
    // back. Without this a focused card's Enter would answer a card nobody can see, or a permission prompt's Enter.
    createEffect(() => {
      if (focused() && (!active() || !current())) unfocus()
    })
    return dispose
  })

  const offer = (card: ProposalCard) =>
    setCards((list) => (list.some((c) => c.id === card.id) ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card]))

  // A card gone elsewhere (answered in another client): drop it here too.
  const closed = (id: string) => {
    const wasShown = current()?.id === id
    remove(id)
    if (wasShown && focused()) unfocus()
  }

  api.slots.register({
    order: 100,
    slots: {
      session_prompt(_ctx, props) {
        createEffect(() => setActive(props.visible === false ? undefined : props.session_id))
        onCleanup(() => {
          if (active() === props.session_id) setActive(undefined)
        })
        return (
          <box flexDirection="column" flexShrink={0}>
            <Show when={cards().find((card) => card.sessionID === props.session_id)}>
              {(card) => (
                <InlineCard
                  api={api}
                  card={card()}
                  more={cards().filter((c) => c.sessionID === props.session_id).length - 1}
                  focused={focused()}
                  selected={selected()}
                  confirming={confirming() === card().id}
                  onPick={(index) => (focused() ? pick(index) : focus())}
                  onFocus={focus}
                />
              )}
            </Show>
            {/* A click into the input while the card is focused gives the keys back: otherwise Enter, `e` and `n` typed
                there would still answer the card. */}
            <box onMouseDown={() => focused() && unfocus()}>
              <api.ui.Prompt
                sessionID={props.session_id}
                visible={props.visible}
                disabled={props.disabled}
                onSubmit={props.on_submit}
                ref={(ref) => {
                  prompt = ref
                  props.ref?.(ref)
                }}
                right={<api.ui.Slot name="session_prompt_right" session_id={props.session_id} />}
              />
            </box>
          </box>
        )
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: FOCUS_COMMAND,
        title: "Review the proposed rule",
        desc: "Move to the proposed-rule card above the input",
        category: "Altimate",
        namespace: "palette",
        run: focus,
      },
    ],
    bindings: [{ key: FOCUS_KEY, cmd: FOCUS_COMMAND }],
  })

  const load = async () => {
    const result = await raw(api)?.get({ url: "/rule-proposal" }).catch(() => undefined)
    // The server's open cards are the truth: anything else here was closed while this TUI was not listening.
    if (Array.isArray(result?.data)) setCards(result.data as ProposalCard[])
  }

  const offs: (() => void)[] = []
  let disposed = false
  const listen = (type: string, handler: (event: { properties: any }) => void) => void offs.push(on(api)(type, handler))
  listen("rule.proposal.asked", (event) => offer(event.properties as ProposalCard))
  listen("rule.proposal.updated", (event) => offer(event.properties as ProposalCard))
  listen("rule.proposal.replied", (event) => closed((event.properties as { id: string }).id))
  // Each decision is shown once per project and per account and workspace (the summary's `notices_scope`), whether it
  // arrived as an event or was pulled before this TUI subscribed (the startup sync): remembered by kind, id and status.
  // The first time a project, account and workspace are seen, their existing decisions are recorded silently: they are
  // history, not news (as the plugins and the extension do on their first run).
  let scope: string | undefined
  const seenKey = () => `altimate.rules.notices.${root(api)}.${scope}`
  const notify = (p: Shown, quiet = false) => {
    const seen = new Set(api.kv.get<string[]>(seenKey(), []))
    const key = shownKey(p)
    if (seen.has(key)) return
    api.kv.set(seenKey(), [...seen, key].slice(-200))
    if (!quiet) toasterOf(api).push(p)
  }
  // `live`: a decision that arrived as an event before the first replay. It is news even when the replay is the scope's
  // first, which records what was kept before it silently.
  const replay = (live?: Shown) =>
    void summaryOf(api).then((summary) => {
      if (!summary) return
      scope = summary.notices_scope ?? "none"
      const first = api.kv.get<string[] | undefined>(seenKey(), undefined) === undefined
      if (first) api.kv.set(seenKey(), [])
      // Rule reviews and skill/knowledge decisions alike: kept by the session server until replaced, shown here once.
      const decisions: Shown[] = summary.decisions ?? [
        ...(summary.notices ?? []).map((n) => ({ ...n, kind: "rule" as const })),
        ...(summary.review_notices ?? []),
      ]
      const liveKey = live && shownKey(live)
      for (const decision of [...decisions].reverse()) if (shownKey(decision) !== liveKey) notify(decision, first)
      if (live) notify(live)
    })
  // Before the first replay this TUI does not know whose decisions they are: the replay learns it, then shows this one.
  listen("rule.proposal.reviewed", (event) => (scope ? notify(event.properties) : replay(event.properties)))
  listen("altimate.rules.changed", () => replay())
  // This TUI shows proposal cards: it holds the server's renderer lease for its project while it runs, renewed at the
  // interval the server asks for. Without a live lease, the save tools save as before cards and the after-turn check
  // waits. No answer (the server may still be starting): tried again in a few seconds. A refusal (workspaces off, an
  // older server): tried again at the normal interval, not every few seconds.
  let leaseTimer: ReturnType<typeof setTimeout> | undefined
  const lease = async () => {
    if (disposed) return
    const result = await post<{ ok: boolean; renew_ms?: number }>(api, "/rule-proposal/renderer", { client: "tui" }).catch(() => undefined)
    if (disposed) return
    const next = result === undefined
      ? 3_000
      : result.ok === true && typeof result.renew_ms === "number" && result.renew_ms > 0
        ? result.renew_ms
        : 30_000
    leaseTimer = setTimeout(() => void lease(), next)
    leaseTimer.unref?.()
  }
  void lease()
  // A plugin that goes away (reloaded, another server) stops renewing and stops listening, so its lease lapses.
  // Startup: after the session-start sync had a moment, catch up on reviews and cards from before this TUI listened.
  const startup = setTimeout(() => {
    if (disposed) return
    replay()
    void load()
  }, 4_000)
  api.lifecycle?.onDispose?.(() => {
    disposed = true
    if (leaseTimer) clearTimeout(leaseTimer)
    clearTimeout(startup)
    disposeToaster(api)
    for (const off of offs.splice(0)) off()
    disposeEffects()
  })
}


/** A decision as the TUI shows it: an event's properties, or one of the summary's `decisions`. No `kind`: a rule. */
type Shown = { public_id: string; text: string; status: string; reason?: string; reviewer?: string; kind?: "rule" | "skill" | "knowledge" }
/** How a decision is remembered as shown: rule and skill ids live in different id spaces. */
export const shownKey = (p: Pick<Shown, "kind" | "public_id" | "status">) => `${p.kind ?? "rule"}:${p.public_id}:${p.status}`

type DecisionToast = { variant: "success" | "warning" | "info"; message: string; duration: number }

const cleanShown = (raw: Shown): Shown => ({
  ...raw,
  text: printable(raw.text),
  reason: raw.reason && printable(raw.reason),
  reviewer: raw.reviewer && printable(raw.reviewer),
})
const quote = (text: string) => `"${text.length > 80 ? text.slice(0, 79) + "…" : text}"`
// altimate_change start — workspace review: request changes (sent back: a warning, with the reviewer's comment)
/** Ends `text` as a sentence, unless the reviewer's comment already does. */
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)
const isBad = (p: Shown) =>
  p.status === "rejected" || p.status === "changes_requested" || (p.status === "retired" && p.kind !== undefined && p.kind !== "rule")
// altimate_change end

/** The toast for one decision on the person's own rule, skill or knowledge request; none for a rule status this
 * version does not show. */
export function decisionToast(raw: Shown): DecisionToast | undefined {
  const p = cleanShown(raw)
  const who = p.reviewer ? ` by ${p.reviewer}` : ""
  const quoted = quote(p.text)
  // A skill or knowledge base the person submitted to the workspace: `text` is its name.
  if (p.kind && p.kind !== "rule") {
    const what = p.kind === "skill" ? `Your skill ${quoted}` : `Your knowledge base ${quoted}`
    if (p.status === "active") return { variant: "success", message: `${what} was approved${who}. It now reaches the workspace.`, duration: 10000 }
    if (p.status === "rejected") return { variant: "warning", message: `${what} was rejected${who}${p.reason ? ` — ${p.reason}` : ""}`, duration: 15000 }
    if (p.status === "retired") return { variant: "warning", message: `${what} was removed from the workspace${who}${p.reason ? ` — ${p.reason}` : ""}`, duration: 15000 }
    // altimate_change start — workspace review: request changes
    if (p.status === "changes_requested")
      return {
        variant: "warning",
        message: `${sentence(`Changes requested on your ${p.kind === "skill" ? "skill" : "knowledge base"} ${quoted}${who}${p.reason ? ` — ${p.reason}` : ""}`)} ${p.kind === "skill" ? "Change it and send it again with `altimate-code skill publish`." : "Change it and send it again from the workspace's Knowledge tab."}`,
        duration: 20000,
      }
    // altimate_change end
    // A status this version does not know (a newer server) is still shown, not dropped.
    return { variant: "info", message: `${what} is now ${printable(p.status)}${who}.`, duration: 10000 }
  }
  if (p.status === "active") return { variant: "success", message: `Your rule was approved${who}: ${quoted}. It now applies to the team.`, duration: 10000 }
  if (p.status === "rejected") return { variant: "warning", message: `Your rule was rejected${who}: ${quoted}${p.reason ? ` — ${p.reason}` : ""}`, duration: 15000 }
  if (p.status === "retired") return { variant: "info", message: `Retired${who}: ${quoted}`, duration: 10000 }
  // altimate_change start — workspace review: request changes
  if (p.status === "changes_requested")
    return { variant: "warning", message: `${sentence(`Changes requested on your rule${who}: ${quoted}${p.reason ? ` — ${p.reason}` : ""}`)} Open /rules to reword or withdraw it.`, duration: 20000 }
  // altimate_change end
  return undefined
}

/** How many decisions a combined toast names. */
const COMBINED_NAMED = 5

/** One line of a combined toast. */
function decisionLine(raw: Shown): string {
  const p = cleanShown(raw)
  const what = p.kind === "skill" ? "skill" : p.kind === "knowledge" ? "knowledge base" : "rule"
  const did: Record<string, string> = {
    active: "approved",
    rejected: "rejected",
    retired: p.kind && p.kind !== "rule" ? "removed" : "retired",
    // altimate_change start — workspace review: request changes
    changes_requested: "sent back for changes",
    // altimate_change end
  }
  const who = p.reviewer ? ` by ${p.reviewer}` : ""
  const why = isBad(p) && p.reason ? ` — ${p.reason}` : ""
  return `${what} ${quote(p.text)} ${did[p.status] ?? printable(p.status)}${who}${why}`
}

/** The toast for decisions that arrived together. The TUI shows one toast at a time, so several are listed in one
 * rather than each replacing the last; a warning when any of them is a rejection or a removal. */
export function combinedToast(decisions: Shown[]): DecisionToast | undefined {
  const shown = decisions.filter((d) => decisionToast(d) !== undefined)
  if (shown.length <= 1) return shown[0] && decisionToast(shown[0])
  // A TUI closed for a while can replay many at once: a few are named, the rest counted (`/rules` lists them all).
  const named = shown.slice(0, COMBINED_NAMED).map(decisionLine)
  const more = shown.length - named.length
  return {
    variant: shown.some(isBad) ? "warning" : "success",
    message: `${shown.length} decisions on your requests: ${named.join(" · ")}${more > 0 ? ` · and ${more} more (see /rules)` : ""}`,
    duration: 15000,
  }
}

/** Decisions to toast, held for `windowMs` so the ones that arrive together are shown together. `shownSince` tells
 * "Sync now" a decision was (or is about to be) shown since it started, so its summary does not replace it. */
export function decisionToaster(show: (toast: DecisionToast) => void, windowMs = 300, now = () => Date.now()) {
  let queue: Shown[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastShown = Number.NEGATIVE_INFINITY
  const flush = () => {
    timer = undefined
    const toast = combinedToast(queue.splice(0))
    if (!toast) return
    lastShown = now()
    show(toast)
  }
  return {
    push(decision: Shown) {
      queue.push(decision)
      if (timer === undefined) {
        timer = setTimeout(flush, windowMs)
        timer.unref?.()
      }
    },
    flush,
    shownSince: (since: number) => queue.some((d) => decisionToast(d) !== undefined) || lastShown >= since,
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      queue = []
    },
  }
}

const toasters = new WeakMap<TuiPluginApi, ReturnType<typeof decisionToaster>>()
/** This TUI's one decision toaster: shared by the notices and "Sync now". */
function toasterOf(api: TuiPluginApi) {
  let toaster = toasters.get(api)
  if (!toaster) {
    toaster = decisionToaster((toast) => api.ui.toast(toast))
    toasters.set(api, toaster)
  }
  return toaster
}

/** Drops this TUI's toaster: nothing held is shown after the plugin goes away, and a later one starts fresh. */
function disposeToaster(api: TuiPluginApi) {
  toasters.get(api)?.dispose()
  toasters.delete(api)
}

async function showMenu(api: TuiPluginApi) {
  const summary = await summaryOf(api)
  if (!summary) return api.ui.toast({ variant: "error", message: "Rules are not available from the session server.", duration: 6000 })
  const rows = (await get<{ ok: boolean; rules: Row[] }>(api, "/altimate/rules"))?.rules ?? []
  const team = rows.filter((r) => r.source === "team")
  const mine = rows.filter((r) => r.source === "mine")
  // altimate_change start — workspace review: the person's skill and knowledge requests, in the same view
  // Bounded: the list asks the server (the link, every page of requests); a slow server must not hold the menu.
  let slow: ReturnType<typeof setTimeout> | undefined
  const listed = await Promise.race([
    get<RequestsResponse>(api, "/altimate/workspace/requests"),
    new Promise<"slow">((resolve) => (slow = setTimeout(() => resolve("slow"), REQUESTS_WAIT_MS))),
  ]).finally(() => clearTimeout(slow))
  const allRequests = listed === "slow" ? [] : (listed?.requests ?? [])
  const requests = allRequests.filter((r) => r.kind !== "rule")
  // What the person may do on a proposal still open on the server (withdraw, send a new wording), by its id.
  const ruleRequests = new Map(allRequests.filter((r) => r.kind === "rule").map((r) => [r.public_id, r]))
  const requestsNote = requestsProblem(listed)
  // altimate_change end
  const status = summary.linked
    ? printable(`${summary.workspace?.name ?? "Workspace"} · ${summary.line}${summary.pulled_at ? ` · synced ${describeAge(Date.parse(summary.pulled_at))}` : ""}`)
    : "Not linked to a workspace — run `altimate-code link`"
  const learning = `Learning from sessions: ${summary.learning ? "on" : "off"} (${sourceLabel(summary.learning_source)})`
  const label: Record<string, string> = {
    active: "approved",
    pending: "pending review",
    rejected: "rejected",
    queued: "queued",
    retired: "retired",
    superseded: "replaced",
    // altimate_change start — workspace review: request changes
    changes_requested: "changes requested",
    withdrawn: "withdrawn",
    // altimate_change end
  }
  const options: TuiDialogSelectOption<string>[] = [
    ...team.map((r) => ({
      title: `${r.pinned ? "📌 " : ""}${printable(r.text)}`,
      value: `rule:${r.public_id}`,
      description: r.applies_to.length ? `applies to ${printable(r.applies_to.join(", "))}` : "whole repository",
      category: `Team rules (${team.length})`,
    })),
    ...mine.map((r) => ({
      title: printable(r.text),
      value: `mine:${r.public_id}`,
      description: `${label[r.status] ?? printable(r.status)}${r.reviewer ? ` by ${printable(r.reviewer)}` : ""}${r.reason ? ` — ${printable(r.reason)}` : ""}`,
      category: `Your proposals (${mine.length})`,
    })),
    // altimate_change start — workspace review
    ...(requestsNote ? [{ ...requestsNote, value: "requests-note", category: "Your skill and knowledge requests" }] : []),
    ...requests.map((r) => ({
      title: `${r.kind === "skill" ? "Skill" : "Knowledge"}: ${printable(r.name)}`,
      value: `request:${r.public_id}`,
      description: requestLine(r),
      category: `Your skill and knowledge requests (${requests.length})`,
    })),
    // altimate_change end
    { title: "Sync now", value: "sync", description: summary.last_error ? `last sync: ${printable(summary.last_error)}` : "Pull approved rules and send queued proposals", category: "Actions" },
    {
      title: summary.learning ? "Turn learning off for me" : "Turn learning on for me",
      value: "toggle",
      description: `${learning}. Just for you, in this project; it overrides the workspace's "Learn from sessions".`,
      category: "Actions",
    },
    ...(summary.personal_learning !== undefined
      ? [{ title: "Follow the workspace setting again", value: "follow", description: "Forget your own choice for this project", category: "Actions" }]
      : []),
  ]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Rules — ${status}`}
      options={options}
      onSelect={async (option) => {
        // altimate_change start — workspace review: withdraw or remove one of the person's requests
        if (option.value.startsWith("request:")) {
          const request = requests.find((r) => `request:${r.public_id}` === option.value)
          if (request?.actions.length) return showRequestActions(api, request)
          // Decided, replaced or withdrawn: nothing to do from here.
          if (request) api.ui.toast({ variant: "info", message: `Nothing to do on this request: it is ${requestStatus(request)}.`, duration: 5000 })
          return
        }
        if (option.value.startsWith("mine:")) {
          const request = ruleRequests.get(option.value.slice("mine:".length))
          if (request?.actions.length) return showRuleActions(api, request)
          return
        }
        if (option.value === "requests-note") {
          api.ui.dialog.clear()
          return api.ui.toast({ variant: "warning", message: requestsNote?.description ?? "", duration: 6000 })
        }
        // altimate_change end
        // Sync and the learning toggle are actions, not navigation: close the menu, report with a toast.
        if (option.value === "sync" || option.value === "toggle" || option.value === "follow") api.ui.dialog.clear()
        if (option.value === "sync") {
          api.ui.toast({ variant: "info", message: "Syncing rules…", duration: 3000 })
          const started = Date.now()
          const report = await post<{ ok: boolean; error?: string; pull?: { ok: boolean; rules: number; pending: number; error?: string; notices: unknown[] }; push?: { sent: unknown[]; queued?: number; error?: string }; context?: { status: string; reason?: string } }>(api, "/altimate/rules/sync").catch(() => undefined)
          // A review notice from this pull is its own toast: the success summary would cover it, but a problem (proposals
          // kept queued, a failed pull) is still said.
          // A skill or knowledge decision this sync found arrives as an event, not in `pull.notices`: the TUI shows one
          // toast at a time, so the summary must not replace it either.
          const reviewed = !!report?.pull?.notices.length || toasterOf(api).shownSince(started)
          if (report?.context && report.context.status !== "ready")
            api.ui.toast({ variant: "warning", message: `Rules sync skipped: ${printable(report.context.reason ?? report.context.status)}.`, duration: 8000 })
          else if (report?.pull?.ok && report.push?.error)
            api.ui.toast({ variant: "warning", message: `Synced ${report.pull.rules} team ${report.pull.rules === 1 ? "rule" : "rules"}, but ${report.push.queued ?? 0} ${report.push.queued === 1 ? "proposal stays" : "proposals stay"} queued: ${printable(report.push.error)}`, duration: 10000 })
          else if (report?.pull?.ok && reviewed) return
          else if (report?.pull?.ok)
            api.ui.toast({ variant: "success", message: `Synced: ${report.pull.rules} team ${report.pull.rules === 1 ? "rule" : "rules"}, ${report.pull.pending} pending review${report.push?.sent.length ? `, ${report.push.sent.length} sent` : ""}.`, duration: 6000 })
          else api.ui.toast({ variant: "error", message: `Rules sync failed: ${printable(report?.pull?.error ?? report?.error ?? "the session server did not answer")}`, duration: 8000 })
          return
        }
        if (option.value === "toggle" || option.value === "follow") {
          const on = option.value === "follow" ? null : !summary.learning
          const next = await post<Summary & { error?: string }>(api, "/altimate/rules/learning", { on }).catch(() => undefined)
          if (!next?.ok) return api.ui.toast({ variant: "error", message: `Learning not changed: ${printable(next?.error ?? "the session server did not answer")}`, duration: 8000 })
          const source = sourceLabel(next.learning_source)
          // Under an organization policy the choice is kept but does not decide: say so instead of claiming it did.
          if (next.learning_source === "organization")
            return api.ui.toast({ variant: "warning", message: `Learning from sessions stays ${next.learning ? "on" : "off"}: your organization's policy decides it.`, duration: 8000 })
          api.ui.toast({ variant: "success", message: `Learning from sessions is ${next.learning ? "on" : "off"} for you in this project (${source}).`, duration: 6000 })
          return
        }
      }}
    />
  ))
}

// altimate_change start — workspace review: the person's requests (`GET /altimate/workspace/requests`)
interface WorkspaceRequest {
  kind: "rule" | "skill" | "knowledge"
  public_id: string
  name: string
  status: string
  change?: string
  reason?: string
  reviewer?: string
  version?: number
  expired?: boolean
  actions: ("withdraw" | "remove" | "resubmit")[]
}
type RequestsResponse = { ok: boolean; requests?: WorkspaceRequest[]; review_status?: string; review_error?: string; review_complete?: boolean }
/** How long `/rules` waits for the person's skill and knowledge requests before opening without them. */
const REQUESTS_WAIT_MS = 5_000

const REQUEST_STATUS: Record<string, string> = {
  pending: "pending review",
  // altimate_change start — workspace review: request changes
  changes_requested: "changes requested",
  // altimate_change end
  active: "approved",
  rejected: "rejected",
  superseded: "replaced by a newer request",
  withdrawn: "withdrawn",
  retired: "removed from the workspace",
}

/** A request's status in words; one this version does not know is shown as the server says it. */
const requestStatus = (r: Pick<WorkspaceRequest, "status">) => REQUEST_STATUS[r.status] ?? printable(r.status)

/** Why the skill and knowledge part of `/rules` is missing or short, as a row: undefined when it is whole, or absent for
 * a reason the header already says (signed out, not linked) or that is no fault (a server without review). */
export function requestsProblem(listed: RequestsResponse | "slow" | undefined): { title: string; description: string } | undefined {
  if (listed === "slow") return { title: "Your skill and knowledge requests did not load in time", description: "Open /rules again in a moment." }
  if (!listed?.ok) return { title: "Your skill and knowledge requests could not be loaded", description: "The session server did not answer. Open /rules again in a moment." }
  if (listed.review_status === "failed")
    return { title: "Your skill and knowledge requests could not be loaded", description: printable(listed.review_error ?? "The workspace did not answer.") }
  if (listed.review_status === "account_changed")
    return { title: "Your skill and knowledge requests are not shown", description: "The account signed in changed. Open /rules again." }
  if (listed.review_complete === false)
    return { title: "Showing your most recent skill and knowledge requests", description: "Older ones are in the Altimate web app." }
  return undefined
}

function requestLine(r: WorkspaceRequest): string {
  const status = requestStatus(r)
  const by = r.reviewer && r.status !== "pending" ? ` by ${printable(r.reviewer)}` : ""
  const update = r.change === "edit" ? " · update" : ""
  const expired = r.expired ? " · waiting over 14 days" : ""
  return `${status}${by}${update}${expired}${r.reason ? ` — ${printable(r.reason)}` : ""}`
}

/** Withdraw a waiting request, or remove an approved one from the workspace. Removing stops serving it to the
 * whole team, so it asks again, opening on "No" so a stray Enter cannot remove it. */
function showRequestActions(api: TuiPluginApi, request: WorkspaceRequest) {
  const what = `${request.kind === "skill" ? "skill" : "knowledge base"} "${printable(request.name)}"`
  const options: TuiDialogSelectOption<string>[] = [
    ...(request.actions.includes("withdraw")
      ? [{ title: "Withdraw the request", value: "withdraw", description: "Take it back before it is reviewed. You can send it again later." }]
      : []),
    ...(request.actions.includes("remove")
      ? [{ title: "Remove from the workspace", value: "remove", description: "Stop serving it to the team. You can send it again later." }]
      : []),
    { title: "Cancel", value: "cancel" },
  ]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Your ${what}`}
      options={options}
      onSelect={(option) => {
        if (option.value === "withdraw") return void runRequestAction(api, request, what, "withdraw")
        if (option.value === "remove") return confirmRemove(api, request, what)
        return void showMenu(api)
      }}
    />
  ))
}

function confirmRemove(api: TuiPluginApi, request: WorkspaceRequest, what: string) {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect<string>
      title={`Remove your ${what} from the workspace?`}
      options={[
        { title: "No, keep it", value: "no", description: "Nothing changes." },
        { title: "Yes, remove it", value: "yes", description: "Teammates stop getting it. You can send it again later." },
      ]}
      current="no"
      onSelect={(choice) => {
        if (choice.value === "yes") return void runRequestAction(api, request, what, "remove")
        return showRequestActions(api, request)
      }}
    />
  ))
}

/** One of the person's rule proposals still open on the server: send a new wording of one sent back for changes, or
 * withdraw it. */
function showRuleActions(api: TuiPluginApi, request: WorkspaceRequest) {
  const sentBack = request.status === "changes_requested"
  const options: TuiDialogSelectOption<string>[] = [
    ...(request.actions.includes("resubmit")
      ? [{ title: "Send a new wording", value: "resubmit", description: "It replaces this proposal and goes back to review." }]
      : []),
    ...(request.actions.includes("withdraw")
      ? [{ title: "Withdraw the proposal", value: "withdraw", description: "Take it back. You can propose it again later." }]
      : []),
    { title: "Cancel", value: "cancel" },
  ]
  const comment = sentBack && request.reason ? ` — ${printable(request.reason)}` : ""
  const asked = sentBack && request.reason ? ` Asked: ${printable(request.reason)}` : ""
  const act = async (action: "withdraw" | "resubmit", text?: string) => {
    const result = await post<{ ok: boolean; error?: string; code?: string }>(
      api,
      `/altimate/rules/${encodeURIComponent(request.public_id)}/${action}`,
      text === undefined ? {} : { text },
    ).catch(() => undefined)
    if (!result?.ok)
      return api.ui.toast({ variant: "error", message: `Not ${action === "withdraw" ? "withdrawn" : "sent"}: ${printable(result?.error ?? "the session server did not answer")}`, duration: 8000 })
    api.ui.toast({
      variant: "success",
      message: action === "withdraw" ? `Withdrew your proposal ${quote(printable(request.name))}.` : "Sent the new wording for review.",
      duration: 6000,
    })
  }
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Your proposal: ${requestStatus(request)}${request.reviewer ? ` by ${printable(request.reviewer)}` : ""}${comment}`}
      options={options}
      onSelect={(option) => {
        if (option.value === "withdraw") {
          api.ui.dialog.clear()
          return void act("withdraw")
        }
        if (option.value !== "resubmit") return void showMenu(api)
        api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt
            title="New wording"
            description={() => <text fg={api.theme.current.textMuted}>One line, at most 140 characters.{asked}</text>}
            value={request.name}
            onConfirm={(text) => {
              api.ui.dialog.clear()
              void act("resubmit", text)
            }}
            onCancel={() => showRuleActions(api, request)}
          />
        ))
      }}
    />
  ))
}

async function runRequestAction(
  api: TuiPluginApi,
  request: WorkspaceRequest,
  what: string,
  action: "withdraw" | "remove",
) {
  api.ui.dialog.clear()
  const result = await post<{ ok: boolean; error?: string; code?: string; request?: WorkspaceRequest }>(
    api,
    `/altimate/workspace/requests/${encodeURIComponent(request.public_id)}/${action}`,
    { expected_version: request.version },
  ).catch(() => undefined)
  if (!result?.ok)
    return api.ui.toast({
      variant: "error",
      message: `Not ${action === "withdraw" ? "withdrawn" : "removed"}: ${printable(result?.error ?? "the session server did not answer")}`,
      duration: 8000,
    })
  api.ui.toast({
    variant: "success",
    message: action === "withdraw" ? `Withdrew your ${what}.` : `Removed your ${what} from the workspace.`,
    duration: 6000,
  })
}
// altimate_change end

const tui: TuiPlugin = async (api) => {
  installCards(api)
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.rules",
        title: "Rules",
        desc: "Team rules, your proposed rules, your skill and knowledge requests and their review status, sync",
        category: "Altimate",
        namespace: "palette",
        slashName: "rules",
        run() {
          showMenu(api).catch((err) => api.ui.toast({ variant: "error", message: printable(String(err)), duration: 8000 }))
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }

export default plugin
