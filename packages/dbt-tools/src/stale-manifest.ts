import type { ParsedManifest, StaleManifest } from "@altimateai/dbt-integration"

// Set when the project check failed and the last parse read what an earlier parse left on disk.
let stale: StaleManifest | undefined

/** Takes each parsed manifest from the adapter, whose graph lookups don't say which one they used. */
export function recordManifest(parsed: ParsedManifest): void {
  stale = parsed.stale
}

function ago(ms: number): string {
  const format = new Intl.RelativeTimeFormat("en")
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return format.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 48) return format.format(-hours, "hour")
  return format.format(-Math.round(hours / 24), "day")
}

/** What an answer built from the manifest adds, or undefined when the manifest is current. */
export function staleManifestNote(now = Date.now()) {
  if (!stale) return undefined
  const age = Math.max(0, now - stale.writtenAt)
  return {
    message: `The dbt project check failed, so this comes from the manifest of the last successful parse, written ${ago(age)}. It may not match the project as it is now.`,
    manifest_path: stale.manifestPath,
    written_at: new Date(stale.writtenAt).toISOString(),
    age_seconds: Math.round(age / 1000),
  }
}
