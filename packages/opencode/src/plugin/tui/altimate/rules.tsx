// altimate_change - new file
//
// Workspace rules in the TUI: a thin renderer of the session server's rule events.
//
// - The proposed-rule card, inline above the session's input (the `session_prompt` slot, which renders the
//   regular input below it): renders `rule.proposal.asked` (and `.updated` after an edit) and answers with
//   `POST /rule-proposal/:id/reply`. Typing is never blocked. `<leader>p` (or a click) focuses the card; then
//   Enter takes the selected action (first: send for review for a member, approve now for the owner), `e` edits
//   the wording, `n` is "Not a rule", Escape goes back to typing and leaves the card. When the wording did not
//   say rule or memory, the card asks "Memory · Team rule · Skip". Open proposals load at startup, so a card
//   asked before this TUI subscribed still shows; one answered in another client disappears.
// - Review notices: `rule.proposal.reviewed` becomes a toast ("approved", or "rejected" with the reason).
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

const on = (api: TuiPluginApi) => api.event.on as unknown as (type: string, handler: (event: { properties: any }) => void) => () => void
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
  if (action === "send") return `Goes to ${owner}'s queue in ${ws} → Rules. Nothing changes for the team until approved.`
  if (action === "approve") return `You own ${ws}: it reaches every teammate's sessions within a few minutes.`
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
  // Each review is shown once per project, whether it arrived as an event or was pulled before this TUI
  // subscribed (the startup sync): remembered by id and status.
  // The first time a project is seen, its existing reviews are recorded silently: they are history, not news.
  const seenKey = () => `altimate.rules.notices.${root(api)}`
  const notify = (p: { public_id: string; text: string; status: string; reason?: string; reviewer?: string }, quiet = false) => {
    const seen = new Set(api.kv.get<string[]>(seenKey(), []))
    const key = `${p.public_id}:${p.status}`
    if (seen.has(key)) return
    api.kv.set(seenKey(), [...seen, key].slice(-200))
    if (!quiet) reviewToast(api, p)
  }
  listen("rule.proposal.reviewed", (event) => notify(event.properties))
  const replay = () =>
    void summaryOf(api).then((summary) => {
      const first = api.kv.get<string[] | undefined>(seenKey(), undefined) === undefined
      if (first) api.kv.set(seenKey(), [])
      for (const notice of [...(summary?.notices ?? [])].reverse()) notify(notice, first)
    })
  listen("altimate.rules.changed", replay)
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
    for (const off of offs.splice(0)) off()
    disposeEffects()
  })
}


function reviewToast(api: TuiPluginApi, raw: { text: string; status: string; reason?: string; reviewer?: string }) {
  const p = { ...raw, text: printable(raw.text), reason: raw.reason && printable(raw.reason), reviewer: raw.reviewer && printable(raw.reviewer) }
  const who = p.reviewer ? ` by ${p.reviewer}` : ""
  const quoted = `"${p.text.length > 80 ? p.text.slice(0, 79) + "…" : p.text}"`
  if (p.status === "active") api.ui.toast({ variant: "success", message: `Your rule was approved${who}: ${quoted}. It now applies to the team.`, duration: 10000 })
  else if (p.status === "rejected") api.ui.toast({ variant: "warning", message: `Your rule was rejected${who}: ${quoted}${p.reason ? ` — ${p.reason}` : ""}`, duration: 15000 })
  else if (p.status === "retired") api.ui.toast({ variant: "info", message: `Retired${who}: ${quoted}`, duration: 10000 })
}

async function showMenu(api: TuiPluginApi) {
  const summary = await summaryOf(api)
  if (!summary) return api.ui.toast({ variant: "error", message: "Rules are not available from the session server.", duration: 6000 })
  const rows = (await get<{ ok: boolean; rules: Row[] }>(api, "/altimate/rules"))?.rules ?? []
  const team = rows.filter((r) => r.source === "team")
  const mine = rows.filter((r) => r.source === "mine")
  const status = summary.linked
    ? printable(`${summary.workspace?.name ?? "Workspace"} · ${summary.line}${summary.pulled_at ? ` · synced ${describeAge(Date.parse(summary.pulled_at))}` : ""}`)
    : "Not linked to a workspace — run `altimate-code link`"
  const learning = `Learning from sessions: ${summary.learning ? "on" : "off"} (${sourceLabel(summary.learning_source)})`
  const label: Record<string, string> = { active: "approved", pending: "pending review", rejected: "rejected", queued: "queued", retired: "retired", superseded: "replaced" }
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
        // Sync and the learning toggle are actions, not navigation: close the menu, report with a toast.
        if (option.value === "sync" || option.value === "toggle" || option.value === "follow") api.ui.dialog.clear()
        if (option.value === "sync") {
          api.ui.toast({ variant: "info", message: "Syncing rules…", duration: 3000 })
          const report = await post<{ ok: boolean; error?: string; pull?: { ok: boolean; rules: number; pending: number; error?: string; notices: unknown[] }; push?: { sent: unknown[]; queued?: number; error?: string }; context?: { status: string; reason?: string } }>(api, "/altimate/rules/sync").catch(() => undefined)
          // A review notice from this pull is its own toast: the success summary would cover it, but a problem (proposals
          // kept queued, a failed pull) is still said.
          const reviewed = !!report?.pull?.notices.length
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

const tui: TuiPlugin = async (api) => {
  installCards(api)
  api.keymap.registerLayer({
    commands: [
      {
        name: "altimate.rules",
        title: "Rules",
        desc: "Team rules, your proposed rules and their review status, sync",
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
