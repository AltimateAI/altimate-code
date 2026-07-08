import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createMemo, Match, on, onMount, Show, Switch } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { Logo } from "../component/logo"
import { Tips } from "../component/tips"
import { Locale } from "@/util/locale"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useDirectory } from "../context/directory"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { Installation } from "@/installation"
import { useKV } from "../context/kv"
import { useCommandDialog } from "../component/dialog-command"
import { useLocal } from "../context/local"
// altimate_change start — first-run chat lock
import { useReady } from "../component/dialog-model"
// altimate_change end
// altimate_change start — upgrade indicator import
import { UpgradeIndicator } from "../component/upgrade-indicator"
// altimate_change end

// TODO: what is the best way to do this?
let once = false

export function Home() {
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const command = useCommandDialog()
  const mcp = createMemo(() => Object.keys(sync.data.mcp).length > 0)
  const mcpError = createMemo(() => {
    return Object.values(sync.data.mcp).some((x) => x.status === "failed")
  })

  const connectedMcpCount = createMemo(() => {
    return Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  })

  // altimate_change start — upstream_fix: race condition shows beginner UI flash before sessions loaded
  const isFirstTimeUser = createMemo(() => {
    // Don't evaluate until sessions have actually loaded (avoid flash of beginner UI)
    // Return undefined to represent "loading" state
    if (sync.status === "loading" || sync.status === "partial") return undefined
    return sync.data.session.length === 0
  })
  // altimate_change end
  const tipsHidden = createMemo(() => kv.get("tips_hidden", false))
  const showTips = createMemo(() => {
    // Always show tips — first-time users need guidance the most
    return !tipsHidden()
  })

  command.register(() => [
    {
      title: tipsHidden() ? "Show tips" : "Hide tips",
      value: "tips.toggle",
      keybind: "tips_toggle",
      category: "System",
      onSelect: (dialog) => {
        kv.set("tips_hidden", !tipsHidden())
        dialog.clear()
      },
    },
  ])

  const Hint = (
    <Show when={connectedMcpCount() > 0}>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          <Switch>
            <Match when={mcpError()}>
              <span style={{ fg: theme.error }}>•</span> mcp errors{" "}
              <span style={{ fg: theme.textMuted }}>ctrl+x s</span>
            </Match>
            <Match when={true}>
              <span style={{ fg: theme.success }}>•</span>{" "}
              {Locale.pluralize(connectedMcpCount(), "{} mcp server", "{} mcp servers")}
            </Match>
          </Switch>
        </text>
      </box>
    </Show>
  )

  let prompt: PromptRef
  const args = useArgs()
  const local = useLocal()
  // altimate_change start — first-run welcome panel (shown until a provider is ready)
  const ready = useReady()
  // Rounded boot panel. zIndex keeps it above transient top toasts (update/MCP) that
  // would otherwise blank its top rows during first-run onboarding.
  const WelcomePanel = () => (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title=" Altimate Code "
      titleAlignment="left"
      flexShrink={0}
      width={75}
      zIndex={2000}
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Welcome to Altimate Code
      </text>
      <box gap={0}>
        <text fg={theme.textMuted}>The intelligence layer for data engineering AI — 100+ deterministic</text>
        <text fg={theme.textMuted}>tools for SQL, column-level lineage, dbt, FinOps, and warehouses.</text>
        <text fg={theme.textMuted}>Run it standalone, under Claude Code or Codex, or in CI pipelines.</text>
      </box>
      <box gap={0}>
        <text fg={theme.textMuted}>Connect your AI model provider to get started —</text>
        <text fg={theme.textMuted}>75+ providers · Altimate LLM Gateway recommended (10M free tokens).</text>
      </box>
      <text>
        <span style={{ fg: theme.textMuted }}>Get started   </span>
        <span style={{ fg: theme.primary }}>/connect</span>
        <span style={{ fg: theme.textMuted }}> — connect your AI model provider</span>
      </text>
    </box>
  )
  // altimate_change end
  onMount(() => {
    if (once) return
    if (route.initialPrompt) {
      prompt.set(route.initialPrompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
    }
  })

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(
    on(
      () => sync.ready && local.model.ready,
      (ready) => {
        if (!ready) return
        if (!args.prompt) return
        if (prompt.current?.input !== args.prompt) return
        prompt.submit()
      },
    ),
  )
  const directory = useDirectory()

  const keybind = useKeybind()

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        {/* altimate_change start — first run: fixed top offset keeps the welcome panel
            clear of the top toast/chrome region (rows ~1-5) which otherwise blanks its
            top; ready users keep the centered logo via a growing spacer */}
        <Show when={ready()} fallback={<box height={5} flexShrink={0} />}>
          <box flexGrow={1} minHeight={0} />
        </Show>
        <Show
          when={ready()}
          fallback={<WelcomePanel />}
        >
          <>
            <box height={4} minHeight={0} flexShrink={1} />
            <box flexShrink={0}>
              <Logo />
            </box>
            <box height={1} minHeight={0} flexShrink={1} />
          </>
        </Show>
        {/* altimate_change end */}
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <Prompt
            ref={(r) => {
              prompt = r
              promptRef.set(r)
            }}
            hint={Hint}
            workspaceID={route.workspaceID}
          />
        </box>
        {/* altimate_change start — first-time onboarding hint (ready users only) */}
        <Show when={ready() && isFirstTimeUser() === true}>
          <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
            <text>
              <span style={{ fg: theme.textMuted }}>Get started: </span>
              <span style={{ fg: theme.text }}>/connect</span>
              <span style={{ fg: theme.textMuted }}> to add your API key</span>
              <span style={{ fg: theme.textMuted }}> · </span>
              <span style={{ fg: theme.text }}>/discover</span>
              <span style={{ fg: theme.textMuted }}> to detect your data stack</span>
              <span style={{ fg: theme.textMuted }}> · </span>
              <span style={{ fg: theme.text }}>Ctrl+P</span>
              <span style={{ fg: theme.textMuted }}> for all commands</span>
            </text>
          </box>
        </Show>
        {/* altimate_change end */}
        <box height={4} minHeight={0} width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
          <Show when={ready() && showTips()}>
            {/* altimate_change start — pass first-time flag for beginner tips */}
            <Tips isFirstTime={isFirstTimeUser() === true} />
            {/* altimate_change end */}
          </Show>
        </box>
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme.textMuted}>{directory()}</text>
        <box gap={1} flexDirection="row" flexShrink={0}>
          <Show when={mcp()}>
            <text fg={theme.text}>
              <Switch>
                <Match when={mcpError()}>
                  <span style={{ fg: theme.error }}>⊙ </span>
                </Match>
                <Match when={true}>
                  <span style={{ fg: connectedMcpCount() > 0 ? theme.success : theme.textMuted }}>⊙ </span>
                </Match>
              </Switch>
              {connectedMcpCount()} MCP
            </text>
            <text fg={theme.textMuted}>/status</text>
          </Show>
        </box>
        <box flexGrow={1} />
        <box flexShrink={0}>
          {/* altimate_change start — upgrade indicator in home footer */}
          <UpgradeIndicator fallback={<text fg={theme.textMuted}>{Installation.VERSION}</text>} />
          {/* altimate_change end */}
        </box>
      </box>
    </>
  )
}
