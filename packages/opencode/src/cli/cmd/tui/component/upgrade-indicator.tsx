import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useKV } from "../context/kv"
import { UPGRADE_KV_KEY, getAvailableVersion } from "./upgrade-indicator-utils"

export function UpgradeIndicator(props: { fallback?: JSX.Element }) {
  const { theme } = useTheme()
  const kv = useKV()
  const dimensions = useTerminalDimensions()

  const latestVersion = createMemo(() => getAvailableVersion(kv.get(UPGRADE_KV_KEY)))
  const isCompact = createMemo(() => dimensions().width < 100)

  return (
    <Show when={latestVersion()} fallback={props.fallback}>
      {(version) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.success}>↑</text>
          <text fg={theme.accent}>{version()}</text>
          <Show when={!isCompact()}>
            <text fg={theme.textMuted}>update available ·</text>
          </Show>
          <text fg={theme.textMuted}>altimate upgrade</text>
        </box>
      )}
    </Show>
  )
}
