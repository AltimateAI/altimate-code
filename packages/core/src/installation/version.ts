declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// altimate_change start — normalize release tags defensively at the shared source of truth
export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION.trim().replace(/^v/, "") : "local"
// altimate_change end
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
