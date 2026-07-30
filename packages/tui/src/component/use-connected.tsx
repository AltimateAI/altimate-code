import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  // altimate_change start — treat undefined cost as "not paid" (upstream `!== 0` was
  // true for undefined, mislabeling OpenCode as connected without a Zen key).
  //
  // Regression grandfather (v0.9.4 release-review fix): the earlier
  // `model.cost?.input != null && model.cost.input !== 0` was tightened to
  // catch OpenCode's cost-less freemium models, but it also excluded
  // legitimate paid providers whose model entries omit the `cost` field —
  // custom `altimate-code.json` registrations, BYOK entries with no
  // per-token metadata, self-hosted deployments. Those users got force-fed
  // the welcome picker on upgrade despite being properly configured.
  //
  // Only OpenCode's free tier needs the cost gate (they populate cost=0
  // deliberately to signal "not paid"). Every other provider is trusted:
  // if it's registered it's connected, cost metadata or not.
  return createMemo(() =>
    sync.data.provider.some((provider) => {
      if (provider.id !== "opencode") return true
      // OpenCode: only counts as "connected" if there's at least one model
      // with a real (nonzero) cost — otherwise it's the free tier where
      // useConnected() should still return false.
      return Object.values(provider.models).some(
        (model) => model.cost?.input != null && model.cost.input !== 0,
      )
    }),
  )
  // altimate_change end
}
