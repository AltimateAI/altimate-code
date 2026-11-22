// altimate_change — redact only exact known credential values in tool results.
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { attach } from "@/effect/run-service"
import { withAlsInstanceRef } from "@/altimate/tool-zod-compat"
import { isSensitiveField, knownStoredCredentials } from "@/altimate/native/connections/credential-store"

const replacement = "[REDACTED]"
const minLength = 8

type Match = { start: number; end: number }
const contentKinds = new Set(["text", "image", "audio", "resource", "resource_link", "file"])

// Decode only JSON escapes and keep a map back to the original output bytes.
// The decoded string is used for comparison, never returned as tool output.
function decodeEscapes(value: string) {
  const checkpoints: Array<{ index: number; extra: number }> = []
  const parts: string[] = []
  const escapes = /\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/g
  let end = 0
  let extra = 0
  for (const match of value.matchAll(escapes)) {
    const index = match.index
    parts.push(value.slice(end, index), JSON.parse('"' + match[0] + '"'))
    const decodedEnd = index - extra + 1
    extra += match[0].length - 1
    checkpoints.push({ index: decodedEnd, extra })
    end = index + match[0].length
  }
  if (!parts.length) return undefined
  parts.push(value.slice(end))
  return {
    value: parts.join(""),
    sourceOffset(index: number) {
      let low = 0
      let high = checkpoints.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (checkpoints[mid].index <= index) low = mid + 1
        else high = mid
      }
      return index + (checkpoints[low - 1]?.extra ?? 0)
    },
  }
}

export function createCredentialRedactor(values: Iterable<string | undefined> = []) {
  const literals = new Set<string>()
  for (const value of values) {
    if (!value || value.length < minLength) continue
    literals.add(value)
    literals.add(JSON.stringify(value).slice(1, -1))
  }
  const ordered = [...literals].sort((a, b) => b.length - a.length)
  const pattern = ordered.length ? new RegExp(ordered.map((value) => RegExp.escape(value)).join("|"), "g") : undefined
  const lookahead = (ordered[0]?.length ?? 0) * 6

  function matches(value: string): Match[] {
    if (!pattern) return []
    const found = Array.from(value.matchAll(pattern), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }))
    const decoded = value.includes("\\") ? decodeEscapes(value) : undefined
    if (!decoded) return found
    for (const match of decoded.value.matchAll(pattern)) {
      found.push({
        start: decoded.sourceOffset(match.index),
        end: decoded.sourceOffset(match.index + match[0].length),
      })
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end)
    const merged: Match[] = []
    for (const match of found) {
      const previous = merged.at(-1)
      if (previous && match.start < previous.end) previous.end = Math.max(previous.end, match.end)
      else merged.push(match)
    }
    return merged
  }

  function replaceMatches(value: string, found: Match[], from = 0, to = value.length, keepLines = false) {
    let cursor = from
    const parts: string[] = []
    for (const { start, end } of found) {
      if (end <= from) continue
      if (start >= to) break
      parts.push(value.slice(cursor, Math.max(cursor, start)), replacement)
      if (keepLines) parts.push("\n".repeat(value.slice(start, end).split("\n").length - 1))
      cursor = end
    }
    if (!parts.length) return value.slice(from, to)
    if (cursor < to) parts.push(value.slice(cursor, to))
    return parts.join("")
  }

  const text = (value: string) => {
    if (!pattern) return value
    if (!value.includes("\\")) return value.replace(pattern, replacement)
    return replaceMatches(value, matches(value))
  }

  function unfinishedStart(value: string) {
    let start = value.length
    for (const literal of ordered) {
      const earliest = Math.max(0, value.length - literal.length + 1)
      for (let i = value.indexOf(literal[0], earliest); i >= 0 && i < start; i = value.indexOf(literal[0], i + 1)) {
        if (literal.startsWith(value.slice(i))) {
          start = i
          break
        }
      }
    }
    return start
  }

  function progress(value: string) {
    // A preview can be published again after the next chunk. Hold a trailing
    // credential prefix until it is either complete or distinguishable.
    if (!pattern) return value
    const unfinishedEscape = /\\(?:u[\da-fA-F]{0,3})?$/.exec(value)
    const completePrefix = unfinishedEscape ? value.slice(0, unfinishedEscape.index) : value
    const decoded = completePrefix.includes("\\") ? decodeEscapes(completePrefix) : undefined
    const comparison = decoded?.value ?? completePrefix
    const unfinished = unfinishedStart(comparison)
    const escapedStart =
      unfinished < comparison.length ? (decoded?.sourceOffset(unfinished) ?? unfinished) : value.length
    const start = Math.min(unfinishedStart(value), escapedStart)
    // Match complete credentials against the original string, including a
    // credential whose tail is also a prefix of another credential.
    return replaceMatches(value, matches(value), 0, start)
  }

  function visit(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") return text(value)
    if (!value || typeof value !== "object") return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const next: unknown[] = []
      seen.set(value, next)
      for (const item of value) next.push(visit(item, seen))
      return next
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const next = Object.create(prototype)
    seen.set(value, next)
    for (const [key, item] of Object.entries(value)) {
      const discriminator = key === "type" && typeof item === "string" && contentKinds.has(item)
      Object.defineProperty(next, key, {
        value: discriminator ? item : visit(item, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return next
  }

  function failure(error: unknown): unknown {
    if (!(error instanceof Error)) return pattern ? visit(error, new WeakMap()) : error
    const message = text(error.message)
    const stack = error.stack === undefined ? undefined : text(error.stack)
    if (message === error.message && stack === error.stack) return error
    const descriptors = Object.getOwnPropertyDescriptors(error)
    return Object.create(Object.getPrototypeOf(error), {
      ...descriptors,
      message: { value: message, writable: true, configurable: true },
      stack: { value: stack, writable: true, configurable: true },
    })
  }

  return {
    failure,
    text,
    lines: (value: string) => replaceMatches(value, matches(value), 0, value.length, true),
    progress,
    preview(value: string, limit: number) {
      // Read enough beyond the cap to match any literal crossing it.
      const scan = value.slice(0, limit + lookahead)
      const prefix = scan.length === value.length ? progress(scan) : text(scan)
      return scan.length < value.length || prefix.length > limit ? prefix.slice(0, limit) + "\n\n..." : prefix
    },
    window(value: string, from: number, to: number) {
      if (!pattern) return value.slice(from, to)
      const start = Math.max(0, from - lookahead)
      const scan = value.slice(start, to + lookahead)
      return replaceMatches(scan, matches(scan), from - start, to - start)
    },
    output<T>(value: T): T {
      return pattern ? (visit(value, new WeakMap()) as T) : value
    },
  }
}

export type CredentialRedactor = ReturnType<typeof createCredentialRedactor>

export function redactToolResultState<T extends { input: unknown; status: string; time: unknown }>(
  state: T,
  redact: CredentialRedactor,
): T {
  const { input, status, time, ...result } = state
  return { ...state, ...redact.output(result), input, status, time }
}

type AddCredential = (value: unknown) => void

// Provider loaders use these environment names outside their catalog declarations.
const providerCredentialVariables = new Set(["AICORE_SERVICE_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SECRET_ACCESS_KEY"])

function isCredentialName(name: string) {
  return /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION)$/i.test(name.replaceAll("-", "_"))
}

function addCredentialHeaders(headers: Record<string, unknown> | undefined, add: AddCredential) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!/(?:^|[-_])(?:authorization|api[-_]key|auth[-_]token|access[-_]token|client[-_]secret)$/i.test(name)) {
      continue
    }
    if (typeof value !== "string") continue
    add(value)
    if (/(?:^|[-_])authorization$/i.test(name)) {
      // Transport values include their scheme, while a tool can return the token alone.
      add(/^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(value)?.[1])
    }
  }
}

function addProviderOptions(options: Record<string, unknown> | undefined, add: AddCredential) {
  add(options?.apiKey)
  add(options?.clientSecret)
  add(options?.accessToken)
  add(options?.refreshToken)
  if (options?.headers && typeof options.headers === "object") {
    addCredentialHeaders(options.headers as Record<string, unknown>, add)
  }
}

function readJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function addConnectionCredential(name: string, value: unknown, add: AddCredential) {
  if (typeof value !== "string" || !value) return
  add(value)
  // BigQuery accepts service-account credentials both as JSON objects and serialized strings.
  if (name === "credentials_json" || name === "keyfile_json") addConnectionFields(readJson(value), add)
}

function addConnectionFields(value: unknown, add: AddCredential): boolean {
  if (!value || typeof value !== "object") return false
  let hasCredential = false
  for (const [key, field] of Object.entries(value)) {
    if (isSensitiveField(key) && typeof field === "string" && field.length >= minLength) {
      hasCredential = true
      addConnectionCredential(key, field, add)
    } else if (addConnectionFields(field, add)) {
      hasCredential = true
    }
  }
  return hasCredential
}

export const loadToolCredentialRedactor = withAlsInstanceRef(
  Effect.gen(function* () {
    // Message projection is below configuration and the connection registry in the import graph.
    const [{ Auth }, { Config }, { Env }, Connections, { Instance }, { McpAuth }, { knownMcpHeaders }] =
      yield* Effect.promise(() =>
        Promise.all([
          import("@/auth"),
          import("@/config/config"),
          import("@/env"),
          import("@/altimate/native/connections/registry"),
          import("@/project/instance"),
          import("@/mcp/auth"),
          import("@/mcp"),
        ]),
      )
    const instance = yield* InstanceRef
    const values = new Set<string>()
    const add = (value: unknown) => {
      if (typeof value === "string") values.add(value)
    }
    const [config, auth, mcpAuth] = yield* Effect.promise(() =>
      Promise.all([
        instance ? Config.get().catch(() => undefined) : undefined,
        Auth.all().catch(() => undefined),
        McpAuth.all().catch(() => undefined),
      ]),
    )
    const environment = [...Object.entries(process.env), ...Object.entries(instance ? Env.all() : {})]
    const configuredVariables = new Set<string>()
    for (const provider of Object.values(config?.provider ?? {})) {
      for (const name of provider.env ?? []) configuredVariables.add(name)
      addProviderOptions(provider.options, add)
      for (const model of Object.values(provider.models ?? {})) {
        addProviderOptions(model.options, add)
        addCredentialHeaders(model.headers, add)
      }
    }
    for (const [name, value] of environment) {
      if (name.startsWith(Connections.CONN_ENV_PREFIX)) {
        if (!value) continue
        const connection = readJson(value)
        // Only credential-bearing connection configurations contribute a composite literal.
        // Keep opaque values for the credential-prefixed variables supported by headless callers.
        if (!connection || typeof connection !== "object" || addConnectionFields(connection, add)) add(value)
      } else if (isCredentialName(name) || providerCredentialVariables.has(name) || configuredVariables.has(name)) {
        add(value)
      }
    }
    for (const entry of Object.values(auth ?? {})) {
      if (entry.type === "oauth") {
        add(entry.access)
        add(entry.refresh)
      } else {
        add(entry.key)
        if (entry.type === "wellknown") add(entry.token)
      }
    }
    for (const entry of Object.values(mcpAuth ?? {})) {
      add(entry.tokens?.accessToken)
      add(entry.tokens?.refreshToken)
      add(entry.clientInfo?.clientSecret)
      add(entry.codeVerifier)
    }
    for (const server of Object.values(config?.mcp ?? {})) {
      if (!("type" in server)) continue
      if (server.type === "remote") {
        addCredentialHeaders(server.headers, add)
        if (typeof server.oauth === "object") add(server.oauth.clientSecret)
      } else {
        for (const [name, value] of Object.entries(server.environment ?? {})) {
          if (isCredentialName(name)) add(value)
        }
      }
    }
    if (instance) {
      for (const headers of knownMcpHeaders(instance)) addCredentialHeaders(headers, add)
      const connections = Instance.restore(instance, () => Connections.knownCredentialConfigs())
      for (const connection of connections) addConnectionFields(connection, add)
    }
    for (const credential of knownStoredCredentials()) addConnectionCredential(credential.field, credential.value, add)
    return createCredentialRedactor(values)
  }),
)

export function toolCredentialRedactor() {
  return Effect.runPromise(attach(loadToolCredentialRedactor))
}
