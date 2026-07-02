import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"
// altimate_change start — upstream_fix: restore first-run home onboarding hint
import { useTheme } from "../context/theme"
// altimate_change end

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

// altimate_change start — upstream_fix: restore first-run home onboarding hint
export function HomeFirstTimeOnboardingHint(props: { isFirstTime: boolean; maxWidth?: number }) {
  const { theme } = useTheme()

  if (!props.isFirstTime) return null

  return (
    <box width="100%" maxWidth={props.maxWidth ?? 75} paddingTop={1} flexShrink={0}>
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
  )
}
// altimate_change end

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  // altimate_change start — upstream_fix: restore first-run home onboarding state
  const connected = createMemo(() =>
    sync.data.provider.some(
      (item) => item.id !== "opencode" || Object.values(item.models).some((model) => model.cost?.input !== 0),
    ),
  )
  const isFirstTimeUser = createMemo(() => sync.ready && sync.data.session.length === 0 && !connected())
  // altimate_change end
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        {/* altimate_change start — upstream_fix: restore first-run home onboarding hint */}
        <HomeFirstTimeOnboardingHint isFirstTime={isFirstTimeUser()} maxWidth={promptMaxWidth()} />
        {/* altimate_change end */}
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
