import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

// altimate_change — feature the Altimate gateway provider first; drop the
// upstream upstream Zen providers (opencode/opencode-go) which we don't ship.
export const popularProviders = [
  "altimate-backend",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

// altimate_change — upstream Zen providers we don't ship. Filtered out of every
// provider list at the source so they never surface in the picker/settings, even
// if the upstream models catalog still lists them.
const hiddenProviderSet = new Set(["opencode", "opencode-go"])

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => decode64(params.dir) ?? "")
  const providers = createMemo(() => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.child(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
  })
  // altimate_change — single filtered source for all derived lists.
  const all = createMemo(() => providers().all.filter((p) => !hiddenProviderSet.has(p.id)))
  const connectedIDs = createMemo(() => new Set(providers().connected))
  const connected = createMemo(() => all().filter((p) => connectedIDs().has(p.id)))
  // altimate_change — no upstream Zen free-provider carve-out; every connected
  // provider (incl. the Altimate gateway) is treated as usable.
  const paid = createMemo(() => connected())
  const popular = createMemo(() => all().filter((p) => popularProviderSet.has(p.id)))
  return {
    all,
    default: createMemo(() => providers().default),
    popular,
    connected,
    paid,
  }
}
