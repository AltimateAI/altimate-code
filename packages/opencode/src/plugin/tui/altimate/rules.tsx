// altimate_change - new file
//
// Workspace rules in the TUI: a thin renderer of the session server's rule events.
//
// - The proposed-rule card: renders `rule.proposal.asked` (and `.updated` after an edit) and answers with
//   `POST /rule-proposal/:id/reply`. Enter sends for review (member) or approves now (owner); `e` edits the wording;
//   `n` is "Not a rule". When the wording did not say rule or memory, the card asks
//   "Save as: Memory · Team rule · Skip". Escape closes the card without answering: the proposal stays open in
//   the session server, and the next queued card shows. Open proposals are loaded at startup, so a card asked
//   before this TUI subscribed still shows.
// - Review notices: `rule.proposal.reviewed` becomes a toast ("approved", or "rejected" with the reason).
// - `/rules`: the team rules, your proposals with their status and reasons, Sync now, and learning on/off.
//
// No rule logic lives here; the IDE extension renders the same events and calls the same routes.
import { TextAttributes } from "@opentui/core"
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { Show } from "solid-js"
import type { ProposalCard } from "@/altimate/rules/events"
import { RulesSummary } from "@/altimate/rules/summary"
import { describeAge } from "@/altimate/workspace/attach-snapshot"
import { writeProjectLearning } from "@/altimate/learn/project-config"

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
const learnConfig = (api: TuiPluginApi) => (api.state.config as { learn?: { enabled?: boolean; capture?: boolean } }).learn

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

function options(card: ProposalCard): TuiDialogSelectOption<string>[] {
  const owner = card.workspace?.owner_name ?? "the workspace owner"
  const ws = card.workspace?.name ?? "the workspace"
  const all: Record<string, TuiDialogSelectOption<string>> = {
    send: {
      title: card.choose ? "Team rule — send for review" : "Send for review",
      value: "send",
      description: `Goes to ${owner}'s queue in ${ws} → Rules. Nothing changes for the team until approved.`,
    },
    approve: {
      title: card.choose ? "Team rule — approve now" : card.weakens_verification ? "Approve anyway" : "Approve now",
      value: "approve",
      description: `You own ${ws}: it reaches every teammate's sessions within a few minutes.`,
    },
    edit: { title: "Edit wording (e)", value: "edit", description: "Change the text before deciding" },
    dismiss: card.choose
      ? { title: "Skip (n)", value: "dismiss", description: "Don't save anything" }
      : { title: "Not a rule (n)", value: "dismiss", description: "Won't propose this topic again for 30 days" },
    save_local: { title: "Save for this project", value: "save_local", description: "Not linked to a workspace: saved as project training, no review" },
    save_memory: { title: "Memory — just for you", value: "save_memory", description: "A fact or preference: saved now, no review, not a team rule" },
  }
  // Enter on the first row takes the team action: "Send for review" (member) or "Approve now" (owner).
  const order = ["save_memory", "send", "save_local", "approve", "edit", "dismiss"]
  return [...card.actions].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((action) => all[action])
}

function CardView(props: { api: TuiPluginApi; card: ProposalCard; onAction: (action: string) => void }) {
  const theme = () => props.api.theme.current
  const card = props.card
  const shortcut = (action: string, key: string, label: string) =>
    card.actions.includes(action as ProposalCard["actions"][number])
      ? [{ command: `rules.card.${action}`, title: label, onTrigger: () => props.onAction(action) }]
      : []
  return (
    <box>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={0}>
        <text attributes={TextAttributes.BOLD} fg={theme().accent}>{title(card)}</text>
        <Show when={card.replaces && card.change === "edit"}>
          <text attributes={TextAttributes.STRIKETHROUGH} fg={theme().textMuted}>{card.replaces!.text}</text>
        </Show>
        <text fg={theme().text} attributes={card.change === "retire" ? TextAttributes.STRIKETHROUGH : undefined}>{card.text}</text>
        <text fg={theme().textMuted}>{meta(card)}</text>
        <Show when={card.why}>
          <text fg={theme().textMuted}>{`Why: ${card.why}`}</text>
        </Show>
        <Show when={card.evidence.correction}>
          <text fg={theme().textMuted}>{`Your correction: "${card.evidence.correction!.excerpt}"`}</text>
        </Show>
        <Show when={card.weakens_verification}>
          <text fg={theme().warning}>{`⚠ ${card.weakens_verification} — the owner must "approve anyway"`}</text>
        </Show>
      </box>
      <props.api.ui.DialogSelect
        title={card.choose ? "Save as" : "What should happen?"}
        options={options(card)}
        renderFilter={false}
        skipFilter
        onSelect={(option) => props.onAction(option.value)}
        actions={[...shortcut("edit", "e", "edit"), ...shortcut("dismiss", "n", card.choose ? "skip" : "not a rule")]}
        bindings={[
          ...(card.actions.includes("edit") ? [{ key: "e", cmd: "rules.card.edit" }] : []),
          { key: "n", cmd: "rules.card.dismiss" },
        ]}
      />
    </box>
  )
}

function installCards(api: TuiPluginApi) {
  const queue: ProposalCard[] = []
  // The card whose dialog (the card, or its edit prompt) is up. Cleared before any programmatic replace or
  // clear, whose close callback would otherwise advance the queue a second time.
  let showing: string | undefined

  const next = () => {
    showing = undefined
    const card = queue.shift()
    if (card) show(card)
  }

  const close = () => {
    showing = undefined
    api.ui.dialog.clear()
  }

  const reply = async (card: ProposalCard, action: string, text?: string) => {
    const result = await post<ReplyResult>(api, `/rule-proposal/${card.id}/reply`, { action, ...(text !== undefined ? { text } : {}) })
      .catch(() => undefined)
    // Closed with Escape while the request ran: the queue already moved on, so only report the outcome.
    const current = showing === card.id
    if (!result) return api.ui.toast({ variant: "error", message: "Could not reach the session server.", duration: 6000 })
    if (!result.ok) {
      api.ui.toast({ variant: "error", message: result.error ?? "Not done.", duration: 8000 })
      if (result.card && current) show(result.card)
      return
    }
    if (action === "edit" && result.card) return current ? show(result.card) : undefined
    api.ui.toast({ variant: "success", message: result.message ?? "Done.", duration: 6000 })
    if (!current) return
    close()
    next()
  }

  const edit = (card: ProposalCard) => {
    showing = undefined
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Edit the rule"
        description={() => <text fg={api.theme.current.textMuted}>One line, at most 140 characters.</text>}
        value={card.text}
        onConfirm={(text) => void reply(card, "edit", text)}
        onCancel={() => show(card)}
      />
    ))
    showing = card.id
  }

  const show = (card: ProposalCard) => {
    showing = undefined
    api.ui.dialog.replace(
      () => (
        <CardView
          api={api}
          card={card}
          onAction={(action) => (action === "edit" ? edit(card) : void reply(card, action))}
        />
      ),
      () => {
        if (showing === card.id) next()
      },
    )
    showing = card.id
    api.ui.dialog.setSize("large")
  }

  const offer = (card: ProposalCard) => {
    if (showing === card.id || queue.some((c) => c.id === card.id)) return
    if (showing || api.ui.dialog.open) queue.push(card)
    else show(card)
  }

  // Wording edited in another client: a queued copy shows the new wording.
  const updated = (card: ProposalCard) => {
    const index = queue.findIndex((c) => c.id === card.id)
    if (index >= 0) queue[index] = card
  }

  // A card queued behind another dialog shows once that dialog closes.
  const drain = setInterval(() => {
    if (!showing && queue.length && !api.ui.dialog.open) next()
  }, 1_000)
  drain.unref?.()

  const load = async () => {
    const result = await raw(api)?.get({ url: "/rule-proposal" }).catch(() => undefined)
    if (Array.isArray(result?.data)) for (const card of result.data as ProposalCard[]) offer(card)
  }

  on(api)("rule.proposal.asked", (event) => offer(event.properties as ProposalCard))
  on(api)("rule.proposal.updated", (event) => updated(event.properties as ProposalCard))
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
  const replay = () => void RulesSummary.summary(root(api), learnConfig(api)).then((s) => [...s.notices].reverse().forEach(notify)).catch(() => {})
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
  const summary = await RulesSummary.summary(root(api), learnConfig(api))
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
        if (option.value === "sync") {
          api.ui.toast({ variant: "info", message: "Syncing rules…", duration: 3000 })
          const report = await post<{ ok: boolean; pull?: { ok: boolean; rules: number; pending: number; error?: string; notices: unknown[] }; push?: { sent: unknown[] }; context?: { status: string; reason?: string } }>(api, "/altimate/rules/sync")
          // A review notice from this pull is its own toast; do not cover it with the summary.
          if (report?.pull?.notices.length) return
          if (report?.context && report.context.status !== "ready")
            api.ui.toast({ variant: "warning", message: `Rules sync skipped: ${report.context.reason ?? report.context.status}.`, duration: 8000 })
          else if (report?.pull?.ok)
            api.ui.toast({ variant: "success", message: `Synced: ${report.pull.rules} team ${report.pull.rules === 1 ? "rule" : "rules"}, ${report.pull.pending} pending review${report.push?.sent.length ? `, ${report.push.sent.length} sent` : ""}.`, duration: 6000 })
          else api.ui.toast({ variant: "error", message: `Rules sync failed: ${report?.pull?.error ?? "unknown error"}`, duration: 8000 })
          return showMenu(api)
        }
        if (option.value === "toggle") {
          const file = await writeProjectLearning(root(api), api.state.path.directory, !summary.learning)
          api.ui.toast({ variant: "success", message: `Learning ${summary.learning ? "off" : "on"} for you in this project (${file}). Applies from the next session.`, duration: 8000 })
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
