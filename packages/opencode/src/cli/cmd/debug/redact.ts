// Fork-only file (not in v1.17.9): extends upstream 82d4c89031.
// Redact only the debug output; the resolved configuration must remain usable by providers.
const secretName =
  /(?:api.?key|access.?key|secret|password|passwd|token$|authorization$|cookie$|credential|private.?key|bearer|passphrase|(?:^|[_-])pwd$|(?:^|[_-])auth(?:[_-]|$)|dsn$|connection.?string)/i

function redactURL(value: string): string {
  // Also covers malformed authorities and opaque schemes such as jdbc:postgresql://.
  const authority = /^[^/?#]*:\/\/([^/?#]*)/.exec(value)?.[1]
  if (authority?.includes("@")) return "***"
  if (!URL.canParse(value)) return /^https?:\/\//i.test(value) ? "***" : value
  const url = new URL(value)
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

// Free-form secret carriers: every environment value is masked, and argv keeps only the
// executable and bare flags (`env TOKEN=x`, `--header "Authorization: ..."`, JDBC strings).
const environmentKey = /^(?:environment|env)$/i
const argvKey = /^(?:command|headersCommand|args)$/i

function redactArgv(argv: unknown[]): unknown[] {
  return argv.map((item, index) =>
    typeof item !== "string" || index === 0 || /^--?[\w.-]+$/.test(item) ? item : "***",
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
      if (Array.isArray(item) && argvKey.test(key) && !headers) return [key, redactArgv(item)]
      const secretScope = headers || /^headers$/i.test(key) || environmentKey.test(key) || secretName.test(key)
      return [key, redactConfig(item, secretScope)]
    }),
  )
}
