import { createMemo, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKV } from "../context/kv"
import { Installation } from "@/installation"
import { UPGRADE_KV_KEY, getAvailableVersion } from "./upgrade-indicator-utils"

export { UPGRADE_KV_KEY } from "./upgrade-indicator-utils"

export function UpgradeIndicator() {
  const { theme } = useTheme()
  const kv = useKV()

  const latestVersion = createMemo(() => getAvailableVersion(kv.get(UPGRADE_KV_KEY)))

  return (
    <Show when={latestVersion()}>
      {(version) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.textMuted}>
            {Installation.VERSION} → <span style={{ fg: theme.accent }}>{version()}</span>
          </text>
          <text fg={theme.textMuted}>·</text>
          <text fg={theme.textMuted}>altimate upgrade</text>
        </box>
      )}
    </Show>
  )
}
