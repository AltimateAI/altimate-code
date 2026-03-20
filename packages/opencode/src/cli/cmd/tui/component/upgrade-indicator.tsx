import { createMemo, Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKV } from "../context/kv"
import { UPGRADE_KV_KEY, getAvailableVersion } from "./upgrade-indicator-utils"

export function UpgradeIndicator(props: { fallback?: JSX.Element }) {
  const { theme } = useTheme()
  const kv = useKV()

  const latestVersion = createMemo(() => getAvailableVersion(kv.get(UPGRADE_KV_KEY)))

  return (
    <Show when={latestVersion()} fallback={props.fallback}>
      {(version) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.success}>↑</text>
          <text fg={theme.accent}>{version()}</text>
          <text fg={theme.textMuted}>update available · altimate upgrade</text>
        </box>
      )}
    </Show>
  )
}
