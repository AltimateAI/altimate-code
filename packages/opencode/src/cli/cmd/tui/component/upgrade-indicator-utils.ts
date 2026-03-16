import { Installation } from "@/installation"

export const UPGRADE_KV_KEY = "update_available_version"

export function getAvailableVersion(kvValue: unknown): string | undefined {
  if (typeof kvValue !== "string") return undefined
  if (kvValue === Installation.VERSION) return undefined
  return kvValue
}
