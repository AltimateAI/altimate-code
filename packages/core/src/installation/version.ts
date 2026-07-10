declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// altimate_change start — normalize release tags defensively at the shared source of truth
export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION.trim().replace(/^v/, "") : "local"
// altimate_change end
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// altimate_change start — upstream_fix: which channels actually have a PUBLISHED release to upgrade to.
// The build script (packages/script/src/index.ts) only creates a release for non-preview builds
// (channel "latest") and the "beta" channel; every other channel — branch names like "main"/"dev"/
// "feature-x"/"upstream/merge-v1.17.9", and "local" — gets an unpublished preview build. For those,
// Installation.latest() would build a non-existent npm dist-tag URL (`.../@altimateai/altimate-code/
// <channel>`) and 404 (and latest() is Effect.orDie → a hard crash). This is an ALLOWLIST, not a
// syntactic "looks like a tag" check: a slash-free branch name (e.g. "main") is still not publishable.
const PUBLISHABLE_CHANNELS: ReadonlySet<string> = new Set(["latest", "beta"])
export function isPublishableChannel(channel: string): boolean {
  return PUBLISHABLE_CHANNELS.has(channel)
}
// altimate_change end
