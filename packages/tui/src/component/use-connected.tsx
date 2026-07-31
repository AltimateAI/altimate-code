import { createMemo } from "solid-js"
import { useSync } from "../context/sync"
import { isAnyProviderConnected } from "../util/connected"

// altimate_change start — treat undefined cost as "not paid" (upstream `!== 0`
// was true for undefined, mislabeling OpenCode as connected without a Zen
// key). The predicate itself lives in ../util/connected so the identical
// check in feature-plugins/home/tips.tsx cannot drift from this one.
export function useConnected() {
  const sync = useSync()
  return createMemo(() => isAnyProviderConnected(sync.data.provider))
}
// altimate_change end
