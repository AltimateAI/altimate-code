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
import { createEffect, createRoot, createSignal, Show } from "solid-js"
import type { ProposalCard } from "@/altimate/rules/events"
import { RulesSummary } from "@/altimate/rules/summary"
import { describeAge } from "@/altimate/workspace/attach-snapshot"
import { readProjectLearning, writeProjectLearning } from "@/altimate/learn/project-config"

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

const on = (api: TuiPluginApi) => api.event.on as unknown as (type: string, handler: (event: { properties: any }) => void) => () => void
const root = (api: TuiPluginApi) => (api.state.path.worktree && api.state.path.worktree !== "/" ? api.state.path.worktree : api.state.path.directory)
type LearnConfig = { enabled?: boolean; capture?: boolean } | undefined
/** The loaded config's `learn`, with the project file's `learn` as on disk now: the `/rules` toggle writes that
 * file, and the loaded config does not change until the next session. */
const learnConfig = async (api: TuiPluginApi): Promise<LearnConfig> => {
  const loaded = (api.state.config as { learn?: LearnConfig }).learn
  const onDisk = (await readProjectLearning(root(api), api.state.path.directory).catch(() => undefined)) as LearnConfig
  return loaded || onDisk ? { ...loaded, ...onDisk } : undefined
}

function title(card: ProposalCard) {
  if (card.choose) return "SAVE THIS?"
  if (card.change === "edit") return "PROPOSED EDIT TO A TEAM RULE"
  if (card.change === "retire") return "PROPOSED: RETIRE A TEAM RULE"
  return card.workspace ? "PROPOSED TEAM RULE" : "PROPOSED RULE"
}

function meta(card: ProposalCard) {
  const parts = [card.applies_to.length ? `applies to ${card.applies_to.join(", ")}` : "applies to the whole repository"]
  if (card.evidence.correction) parts.push(`from your correction ${describeAge(Date.parse(card.evidence.correction.at))}`)
  if (card.evidence.sessions > 1) parts.push(`seen in ${card.evidence.sessions} sessions`)
  parts.push(`${card.chars} chars`)
  return parts.join(" · ")
}

/** Button labels, in the order shown: the team action first, so Enter on a fresh card takes it. */
function buttons(card: ProposalCard): { action: ProposalCard["actions"][number]; label: string }[] {
  const label: Record<ProposalCard["actions"][number], string> = {
    send: card.choose ? "Team rule — send for review" : "Send for review",
    approve: card.choose ? "Team rule — approve now" : card.weakens_verification ? "Approve anyway" : "Approve now",
    save_local: "Save for this project",
    save_memory: "Memory — just for you",
    edit: "Edit wording",
    dismiss: card.choose ? "Skip" : "Not a rule",
  }
  const order = ["save_memory", "send", "approve", "save_local", "edit", "dismiss"]
  return [...card.actions].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((action) => ({ action, label: label[action] }))
}

/** What the team action does, shown under the buttons while the card is focused. */
function explain(card: ProposalCard, action: string): string {
  const owner = card.workspace?.owner_name ?? "the workspace owner"
  const ws = card.workspace?.name ?? "the workspace"
  if (action === "send") return `Goes to ${owner}'s queue in ${ws} → Rules. Nothing changes for the team until approved.`
  if (action === "approve") return `You own ${ws}: it reaches every teammate's sessions within a few minutes.`
  if (action === "save_local") return "Not linked to a workspace: saved as project training, no review."
  if (action === "save_memory") return "A fact or preference: saved now, no review, not a team rule."
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
          <text attributes={TextAttributes.STRIKETHROUGH} fg={theme().textMuted}>{card().replaces!.text}</text>
        </Show>
        <text fg={theme().text} attributes={card().change === "retire" ? TextAttributes.STRIKETHROUGH : undefined}>{card().text}</text>
        <text fg={theme().textMuted}>{meta(card())}</text>
        <Show when={props.focused && card().why}>
          <text fg={theme().textMuted}>{`Why: ${card().why}`}</text>
        </Show>
        <Show when={props.focused && card().evidence.correction}>
          <text fg={theme().textMuted}>{`Your correction: "${card().evidence.correction!.excerpt}"`}</text>
        </Show>
        <Show when={card().weakens_verification}>
          <text fg={theme().warning}>{`⚠ ${card().weakens_verification} — it needs "approve anyway"`}</text>
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
          <text fg={theme().textMuted}>{explain(card(), options()[props.selected]?.action ?? "")}</text>
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
  let prompt: TuiPromptRef | undefined
  let sessionID: string | undefined
  let layer: (() => void) | undefined

  const current = () => cards().find((card) => card.sessionID === sessionID)
  const remove = (id: string) => setCards((list) => list.filter((card) => card.id !== id))

  // The card's keys (enter, e, n, h, l, …) only while it is focused and no dialog is open: under a dialog they
  // would take the dialog's own keys (Enter in "Edit the rule" would re-run the card's selected action).
  const releaseKeys = () => {
    layer?.()
    layer = undefined
  }

  const unfocus = () => {
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
    if (!result.ok) return api.ui.toast({ variant: "error", message: result.error ?? "Not done.", duration: 8000 })
    if (action === "edit") {
      if (result.card) setCards((list) => list.map((c) => (c.id === card.id ? result.card! : c)))
      return
    }
    api.ui.toast({ variant: "success", message: result.message ?? "Done.", duration: 6000 })
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
      () => {
        if (focused()) bindKeys()
      },
    )
  }

  const pick = (index: number) => {
    const card = current()
    const option = card && buttons(card)[index]
    if (!card || !option) return
    setSelected(index)
    if (option.action === "edit") return edit(card)
    void reply(card, option.action)
  }

  const shortcut = (action: string) => {
    const card = current()
    const index = card ? buttons(card).findIndex((b) => b.action === action) : -1
    if (index >= 0) pick(index)
  }

  const move = (step: number) => {
    const card = current()
    if (!card) return
    const count = buttons(card).length
    setSelected((index) => (index + step + count) % count)
  }

  const focus = () => {
    if (!current() || focused()) return
    setSelected(0)
    setFocused(true)
    prompt?.blur()
    bindKeys()
  }

  function bindKeys() {
    if (layer || api.ui.dialog.open) return
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

  // Any other dialog opened while the card is focused (the palette, `/rules`) gets its keys back too.
  createRoot(() =>
    createEffect(() => {
      if (api.ui.dialog.open) releaseKeys()
      else if (focused()) bindKeys()
    }),
  )

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
        sessionID = props.session_id
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
                  onPick={(index) => (focused() ? pick(index) : focus())}
                  onFocus={focus}
                />
              )}
            </Show>
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
    if (Array.isArray(result?.data)) for (const card of result.data as ProposalCard[]) offer(card)
  }

  on(api)("rule.proposal.asked", (event) => offer(event.properties as ProposalCard))
  on(api)("rule.proposal.updated", (event) => offer(event.properties as ProposalCard))
  on(api)("rule.proposal.replied", (event) => closed((event.properties as { id: string }).id))
  // Each review is shown once per project, whether it arrived as an event or was pulled before this TUI
  // subscribed (the startup sync): remembered by id and status.
  const seenKey = () => `altimate.rules.notices.${root(api)}`
  const notify = (p: { public_id: string; text: string; status: string; reason?: string; reviewer?: string }) => {
    const seen = new Set(api.kv.get<string[]>(seenKey(), []))
    const key = `${p.public_id}:${p.status}`
    if (seen.has(key)) return
    api.kv.set(seenKey(), [...seen, key].slice(-200))
    reviewToast(api, p)
  }
  on(api)("rule.proposal.reviewed", (event) => notify(event.properties))
  const replay = () => void learnConfig(api).then((learn) => RulesSummary.summary(root(api), learn)).then((s) => [...s.notices].reverse().forEach(notify)).catch(() => {})
  on(api)("altimate.rules.changed", replay)
  setTimeout(() => {
    replay()
    void load()
  }, 4_000)
}

function reviewToast(api: TuiPluginApi, p: { text: string; status: string; reason?: string; reviewer?: string }) {
  const who = p.reviewer ? ` by ${p.reviewer}` : ""
  const quoted = `"${p.text.length > 80 ? p.text.slice(0, 79) + "…" : p.text}"`
  if (p.status === "active") api.ui.toast({ variant: "success", message: `Your rule was approved${who}: ${quoted}. It now applies to the team.`, duration: 10000 })
  else if (p.status === "rejected") api.ui.toast({ variant: "warning", message: `Your rule was rejected${who}: ${quoted}${p.reason ? ` — ${p.reason}` : ""}`, duration: 15000 })
  else if (p.status === "retired") api.ui.toast({ variant: "info", message: `Retired${who}: ${quoted}`, duration: 10000 })
}

async function showMenu(api: TuiPluginApi) {
  const summary = await RulesSummary.summary(root(api), await learnConfig(api))
  const rows = await RulesSummary.rows(root(api))
  const team = rows.filter((r) => r.source === "team")
  const mine = rows.filter((r) => r.source === "mine")
  const status = summary.linked
    ? `${summary.workspace?.name ?? "Workspace"} · ${RulesSummary.sidebarLine(summary)}${summary.pulled_at ? ` · synced ${describeAge(Date.parse(summary.pulled_at))}` : ""}`
    : "Not linked to a workspace — run `altimate-code link`"
  const learning = `Learning from sessions: ${summary.learning ? "on" : "off"} (${summary.learning_source === "you" ? "your setting" : summary.learning_source === "workspace" ? "workspace setting" : "default"})`
  const label: Record<string, string> = { active: "approved", pending: "pending review", rejected: "rejected", queued: "queued", retired: "retired", superseded: "replaced" }
  const options: TuiDialogSelectOption<string>[] = [
    ...team.map((r) => ({
      title: `${r.pinned ? "📌 " : ""}${r.text}`,
      value: `rule:${r.public_id}`,
      description: r.applies_to.length ? `applies to ${r.applies_to.join(", ")}` : "whole repository",
      category: `Team rules (${team.length})`,
    })),
    ...mine.map((r) => ({
      title: r.text,
      value: `mine:${r.public_id}`,
      description: `${label[r.status] ?? r.status}${r.reviewer ? ` by ${r.reviewer}` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
      category: `Your proposals (${mine.length})`,
    })),
    { title: "Sync now", value: "sync", description: summary.last_error ? `last sync failed: ${summary.last_error}` : "Pull approved rules and send queued proposals", category: "Actions" },
    {
      title: summary.learning ? "Turn learning off for me" : "Turn learning on for me",
      value: "toggle",
      description: `${learning}. Your setting overrides the workspace's "Learn from sessions".`,
      category: "Actions",
    },
  ]
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={`Rules — ${status}`}
      options={options}
      onSelect={async (option) => {
        // Sync and the learning toggle are actions, not navigation: close the menu, report with a toast.
        if (option.value === "sync" || option.value === "toggle") api.ui.dialog.clear()
        if (option.value === "sync") {
          api.ui.toast({ variant: "info", message: "Syncing rules…", duration: 3000 })
          const report = await post<{ ok: boolean; pull?: { ok: boolean; rules: number; pending: number; error?: string; notices: unknown[] }; push?: { sent: unknown[] }; context?: { status: string; reason?: string } }>(api, "/altimate/rules/sync").catch(() => undefined)
          // A review notice from this pull is its own toast; do not cover it with the summary.
          if (report?.pull?.notices.length) return
          if (report?.context && report.context.status !== "ready")
            api.ui.toast({ variant: "warning", message: `Rules sync skipped: ${report.context.reason ?? report.context.status}.`, duration: 8000 })
          else if (report?.pull?.ok)
            api.ui.toast({ variant: "success", message: `Synced: ${report.pull.rules} team ${report.pull.rules === 1 ? "rule" : "rules"}, ${report.pull.pending} pending review${report.push?.sent.length ? `, ${report.push.sent.length} sent` : ""}.`, duration: 6000 })
          else api.ui.toast({ variant: "error", message: `Rules sync failed: ${report?.pull?.error ?? "unknown error"}`, duration: 8000 })
          return
        }
        if (option.value === "toggle") {
          const file = await writeProjectLearning(root(api), api.state.path.directory, !summary.learning).catch((error) => {
            api.ui.toast({ variant: "error", message: `Learning not changed: ${error instanceof Error ? error.message : String(error)}`, duration: 8000 })
            return undefined
          })
          if (file) api.ui.toast({ variant: "success", message: `Learning ${summary.learning ? "off" : "on"} for you in this project (${file}). Applies from the next session.`, duration: 8000 })
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
          showMenu(api).catch((err) => api.ui.toast({ variant: "error", message: String(err), duration: 8000 }))
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }

export default plugin
