// Fork-only file (not in v1.17.9): extends upstream 82d4c89031.
// Redact only the debug output; the resolved configuration must remain usable by providers.
const secretName =
  /(?:api.?key|access.?key|secret|password|passwd|token$|authorization$|cookie$|credential|private.?key|bearer|passphrase|(?:^|[_-])pwd$|(?:^|[_-])auth(?:[_-]|$)|dsn$|connection.?string)/i

function redactURL(value: string): string {
  const trimmed = value.trim()
  // Prose (prompts, descriptions) is not a URL even when it mentions one.
  if (/\s/.test(trimmed)) return value
  // Also covers malformed authorities and opaque schemes such as jdbc:postgresql://.
  const authority = /^(?:[^/?#]*:)?\/\/([^/?#]*)/.exec(trimmed)?.[1]
  if (authority?.includes("@")) return "***"
  // Fail closed for URL-like strings that cannot be safely parsed, regardless of scheme.
  if (!URL.canParse(trimmed)) {
    return authority !== undefined || /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? "***" : value
  }
  const url = new URL(trimmed)
  if (url.username || url.password) return "***"

  const redactParams = (params: string) =>
    params
      .split("&")
      .map((param) => (param ? `${param.split("=", 1)[0]}=***` : param))
      .join("&")

  // Preserve the original URL spelling and fragments that are only anchors.
  return value
    .replace(/^([^?#]*\?)([^#]*)/, (_, prefix, params) => prefix + redactParams(params))
    .replace(/#(.*)/s, (fragment, params) => (params.includes("=") ? `#${redactParams(params)}` : fragment))
}

// Remote server URLs can carry credentials in the path (`/mcp/u/<token>/...`), so print only the origin.
function redactServerURL(value: string): string {
  const trimmed = value.trim()
  if (!URL.canParse(trimmed)) return "***"
  const url = new URL(trimmed)
  if (url.username || url.password || url.origin === "null") return "***"
  const rest = url.pathname.replace(/^\/$/, "") + url.search + url.hash
  return rest ? `${url.origin}/***` : url.origin
}

// Free-form secret carriers: every environment value is masked, and argv keeps only the
// executable (`env TOKEN=x`, `--header "Authorization: ..."`, `-pSecret`, JDBC strings).
const environmentKey = /^(?:environment|env)$/i
const argvKey = /^(?:command|headersCommand|args)$/i

function redactArgv(argv: unknown[]): unknown[] {
  return argv.map((item, index) =>
    typeof item !== "string" || index === 0 ? item : "***",
  )
}

export function redactConfig(value: unknown, headers = false): unknown {
  if (typeof value === "string") return headers ? "***" : redactURL(value)
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
      if (typeof item === "string" && /^url$/i.test(key) && !headers) return [key, redactServerURL(item)]
      if (Array.isArray(item) && argvKey.test(key) && !headers) return [key, redactArgv(item)]
      // headersCommand is a record of header name -> argv.
      if (item && typeof item === "object" && /^headersCommand$/i.test(key) && !headers)
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([name, argv]) => [name, Array.isArray(argv) ? redactArgv(argv) : "***"]),
          ),
        ]
      const secretScope = headers || /^headers$/i.test(key) || environmentKey.test(key) || secretName.test(key)
      return [key, redactConfig(item, secretScope)]
    }),
  )
}
