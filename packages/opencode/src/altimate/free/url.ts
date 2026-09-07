/** Normalize a credential-bearing gateway endpoint. HTTP, userinfo, and URL suffixes are rejected. */
export function normalizeGatewayUrl(value: string): string | undefined {
  const raw = value.trim()
  // URL.search/hash are empty for bare trailing delimiters, so reject the source delimiters too.
  if (!raw || raw.includes("?") || raw.includes("#")) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return url.toString().replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

export * as FreeTierUrl from "./url"
