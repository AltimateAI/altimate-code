import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some(
      (provider) =>
        provider.id !== "opencode" ||
        // altimate_change — treat undefined cost as "not paid" (upstream `!== 0` was
        // true for undefined, mislabeling OpenCode as connected without a Zen key).
        Object.values(provider.models).some((model) => model.cost?.input != null && model.cost.input !== 0),
    ),
  )
}
