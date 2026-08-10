import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes, RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { Link } from "../ui/link"
import {
  createWorkspaceLinkDevice,
  pollWorkspaceLink,
  WorkspaceLinkHttpError,
  type WorkspaceLinkDeviceLink,
} from "../altimate/workspace-link-client"

// altimate_change — WorkspaceLink feature, Path B native dialog (docs/workspace-plan/CONTRACT.md
// §3). Modeled on DialogScanGate (dialog-scan-gate.tsx) for the Y/N gate shape, and on
// AutoMethod (dialog-provider.tsx:338-471) for the code/URL/waiting-state rendering — same
// Link + instructions text, same `c`-to-copy binding, same waiting-vs-connected Show split.
//
// This literal string is asserted on by both the local-No path and the declined/expired path
// (CONTRACT.md §2's "decline persists nothing" — both are the same user-visible outcome: no
// workspace exists either way).
export const WORKSPACE_LINK_DECLINED_MESSAGE = "Nothing was shared — no workspace was created."

export interface WorkspaceLinkOfferSummary {
  name: string | null
  adapter: string | null
  gitRemote: string | null
  modelCount: number | null
  hasWarehouse: boolean
}

/** Step 1: the Y/N consent gate. Zero network calls happen until the user picks Yes — no
 * pending link is created server-side at all on No, a stronger form of "decline persists
 * nothing" than the backend's own terminal-status semantics. */
export function DialogWorkspaceLink(props: { summary: WorkspaceLinkOfferSummary }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()

  onMount(() => dialog.setSize("large"))

  let chosen = false
  function decline() {
    if (chosen) return
    chosen = true
    dialog.clear()
    toast.show({ message: WORKSPACE_LINK_DECLINED_MESSAGE, variant: "info" })
  }
  function accept() {
    if (chosen) return
    chosen = true
    dialog.replace(() => <WorkspaceLinkDevice />)
  }

  // Default-focused option is No (index 1), per this round's placement decision — unlike the
  // scan gate (dialog-scan-gate.tsx), whose Yes is recommended/default.
  const [selected, setSelected] = createSignal(1)
  const options = [
    { label: "Yes", run: accept, help: "Opens a link in your browser to set it up." },
    { label: "No", run: decline, help: "Skip for now. Nothing leaves this machine." },
  ]

  useKeyboard((evt) => {
    if (evt.name === "up" || evt.name === "down") {
      setSelected((prev) => (prev + 1) % 2)
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      options[selected()].run()
      return
    }
    if (evt.name === "y" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      accept()
      return
    }
    if (evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      decline()
    }
  })

  const selFg = selectedForeground(theme)
  const transparent = RGBA.fromInts(0, 0, 0, 0)

  const title = () => `Set up a workspace for ${props.summary.name ?? "this project"}?`

  const summaryLines = createMemo(() => {
    const s = props.summary
    const lines: string[] = []
    if (s.name) lines.push(`project    ${s.name}`)
    if (s.gitRemote) lines.push(`remote     ${s.gitRemote}`)
    if (s.adapter) lines.push(`adapter    ${s.adapter}`)
    if (s.modelCount != null) lines.push(`models     ${s.modelCount}`)
    if (lines.length === 0) lines.push(s.hasWarehouse ? "warehouse connection detected" : "no project details detected")
    return lines
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        title=" Workspace "
        titleAlignment="left"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {title()}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => decline()}>
            esc
          </text>
        </box>
        <text fg={theme.textMuted}>Right now the agent starts from scratch every session.</text>
        <text fg={theme.textMuted}>A workspace changes that:</text>
        {/* Static labels, not data — same three lines regardless of what the scan found. */}
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>Integrations — connect your warehouse and tools</text>
          <text fg={theme.textMuted}>Knowledge    — upload your team's docs and conventions</text>
          <text fg={theme.textMuted}>Memory       — corrections and preferences, remembered</text>
        </box>
        <text fg={theme.textMuted}>This will share with app.altimate.ai:</text>
        <box paddingLeft={2}>
          <For each={summaryLines()}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
        </box>
        <text fg={theme.textMuted}>Nothing else. No SQL, no data, no credentials.</text>
        <box gap={1}>
          <For each={options}>
            {(option, index) => {
              const active = () => selected() === index()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseMove={() => setSelected(index())}
                  onMouseUp={() => option.run()}
                >
                  <text flexShrink={0} fg={theme.primary}>
                    {active() ? "❯" : " "}
                  </text>
                  <box
                    width={6}
                    flexShrink={0}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={active() ? theme.primary : transparent}
                  >
                    <text fg={active() ? selFg : theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
                      {option.label}
                    </text>
                  </box>
                  <box flexGrow={1}>
                    <text wrapMode="word" width="100%">
                      <span style={{ fg: theme.textMuted }}>{option.help}</span>
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </box>
    </box>
  )
}

interface ApprovedInfo {
  approvedBy: string
  workspace: { name: string; slug: string; manage_url: string }
}

/** Step 2: create the device link, render the code/URL, and poll to resolution. The httpapi
 * poll route (handlers/workspace-link.ts) is a single non-blocking attempt per call — the
 * client owns the retry interval and the hard expires_in deadline, mirroring
 * altimate/workspace-link/poll-loop.ts's pollUntilResolved on the opencode side. */
function WorkspaceLinkDevice() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  const [link, setLink] = createSignal<WorkspaceLinkDeviceLink | null>(null)
  const [approved, setApproved] = createSignal<ApprovedInfo | null>(null)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (pollTimer) clearTimeout(pollTimer)
    if (closeTimer) clearTimeout(closeTimer)
  })

  function finishDeclined() {
    if (disposed) return
    dialog.clear()
    toast.show({ message: WORKSPACE_LINK_DECLINED_MESSAGE, variant: "info" })
  }

  function schedulePoll(current: WorkspaceLinkDeviceLink, deadline: number) {
    const intervalMs = Math.max(1, current.interval) * 1000
    const tick = async () => {
      if (disposed) return
      if (Date.now() >= deadline) {
        finishDeclined()
        return
      }
      try {
        const result = await pollWorkspaceLink(sdk, current.link_id, current.poll_token)
        if (disposed) return
        if (result.status === "pending") {
          pollTimer = setTimeout(tick, intervalMs)
          return
        }
        if (result.status === "approved") {
          setApproved({ approvedBy: result.approved_by, workspace: result.workspace })
          closeTimer = setTimeout(() => {
            if (!disposed) dialog.clear()
          }, 8000)
          return
        }
        // declined or expired — same user-visible outcome as a local No.
        finishDeclined()
      } catch {
        // Transient network hiccup — keep waiting; the hard deadline check above still fires
        // once expires_in has genuinely elapsed.
        pollTimer = setTimeout(tick, intervalMs)
      }
    }
    pollTimer = setTimeout(tick, intervalMs)
  }

  onMount(async () => {
    try {
      const created = await createWorkspaceLinkDevice(sdk)
      if (disposed) return
      setLink(created)
      schedulePoll(created, Date.now() + Math.max(0, created.expires_in) * 1000)
    } catch (err) {
      if (disposed) return
      const message = err instanceof WorkspaceLinkHttpError ? err.message : "Failed to create workspace link"
      setErrorMessage(message)
      closeTimer = setTimeout(() => {
        if (!disposed) dialog.clear()
      }, 4000)
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Workspace link
        </text>
        <Show when={!approved()}>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </Show>
      </box>

      <Show when={errorMessage()}>{(message) => <text fg={theme.error}>{message()}</text>}</Show>

      <Show when={!errorMessage() && !link()}>
        <text fg={theme.textMuted}>Creating a one-time link…</text>
      </Show>

      <Show when={approved()} fallback={
        <Show when={link()}>
          {(current) => (
            <box gap={1}>
              <Link href={current().verification_uri} fg={theme.primary} />
              <text fg={theme.textMuted}>
                Expires in {Math.round(current().expires_in / 60)} min
              </text>
              <text fg={theme.textMuted}>Waiting for approval in the browser...</text>
            </box>
          )}
        </Show>
      }>
        {(info) => (
          <box gap={1}>
            <text fg={theme.diffHighlightAdded} attributes={TextAttributes.BOLD}>
              ✓ Approved by {info().approvedBy}
            </text>
            <text fg={theme.diffHighlightAdded} attributes={TextAttributes.BOLD}>
              ✓ Workspace {info().workspace.name} created and linked to this project
            </text>
            <text fg={theme.textMuted}>
              Next: <span style={{ fg: theme.primary }}>altimate code --workspace {info().workspace.slug}</span>
            </text>
            <Link href={info().workspace.manage_url} fg={theme.primary} />
          </box>
        )}
      </Show>
    </box>
  )
}
