// Fork-only file (not in v1.17.9): extends upstream 82d4c89031.
// Redact only the debug output; the resolved configuration must remain usable by providers.
const secretName =
  /(?:api.?key|access.?key|secret|password|passwd|token$|authorization$|cookie$|credential|private.?key|bearer|(?:^|[_-])auth(?:[_-]|$)|dsn$|connection.?string)/i

function credentialURL(value: string): boolean {
  // Also covers malformed authorities and opaque schemes such as jdbc:postgresql://.
  const authority = /^[^/?#]*:\/\/([^/?#]*)/.exec(value)?.[1]
  if (authority?.includes("@")) return true
  if (!URL.canParse(value)) return /^https?:\/\//i.test(value)
  const url = new URL(value)
  return !!(
    url.username ||
    url.password ||
    [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((name) => secretName.test(name))
  )
}

export function redactConfig(value: unknown, headers = false): unknown {
  if (typeof value === "string") return headers || credentialURL(value) ? "***" : value
  if (Array.isArray(value))
    return value.map((item, index) => {
      if (typeof item === "string") {
        const flag = /^--?([^=]+)=/.exec(item)
        const previous = value[index - 1]
        const bare = typeof previous === "string" ? /^--?([^=]+)$/.exec(previous) : null
        if ((flag && secretName.test(flag[1])) || (bare && secretName.test(bare[1]))) return "***"
      }
      return redactConfig(item, headers)
    })
  if (value === null || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && (headers || secretName.test(key))) return [key, "***"]
      return [key, redactConfig(item, headers || key.toLowerCase() === "headers")]
    }),
  )
}
