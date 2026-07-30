import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  // altimate_change start — treat undefined cost as "not paid" (upstream `!== 0` was
  // true for undefined, mislabeling OpenCode as connected without a Zen key).
  return createMemo(() =>
    sync.data.provider.some(
      (provider) =>
        provider.id !== "opencode" ||
        Object.values(provider.models).some((model) => model.cost?.input != null && model.cost.input !== 0),
    ),
  )
  // altimate_change end
}
