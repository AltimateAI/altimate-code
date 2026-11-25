// altimate_change — redact only exact known credential values in tool results.
import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { createHash } from "node:crypto"
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
    literals.add(value.replace(/\r\n?/g, "\n"))
    literals.add(JSON.stringify(value).slice(1, -1))
  }
  const ordered = [...literals].sort((a, b) => b.length - a.length)
  const pattern = ordered.length ? new RegExp(ordered.map((value) => RegExp.escape(value)).join("|"), "g") : undefined
  const longest = ordered[0]?.length ?? 0
  const lookahead = longest * 6

  function matches(value: string): Match[] {
    if (!pattern) return []
    const found: Match[] = []
    const collect = (source: string, offset: (index: number) => number) => {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source))) {
        found.push({ start: offset(match.index), end: offset(match.index + match[0].length) })
        // Continue at the next start, so a second credential can extend past this match.
        pattern.lastIndex = match.index + 1
      }
    }
    collect(value, (index) => index)
    const decoded = value.includes("\\") ? decodeEscapes(value) : undefined
    if (decoded) {
      collect(decoded.value, decoded.sourceOffset)
      found.sort((a, b) => a.start - b.start || b.end - a.end)
    }
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

  const text = (value: string) => (pattern ? replaceMatches(value, matches(value)) : value)

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

  function progressStatus(value: string) {
    // Keep the tail private until more output arrives or the stream ends.
    // Alternate JSON escape spellings can require a longer holdback.
    if (!pattern) return { output: value, withheld: false }
    const unfinishedEscape = /\\(?:u[\da-fA-F]{0,3})?$/.exec(value)
    const completePrefix = unfinishedEscape ? value.slice(0, unfinishedEscape.index) : value
    const decoded = completePrefix.includes("\\") ? decodeEscapes(completePrefix) : undefined
    const comparison = decoded?.value ?? completePrefix
    const unfinished = unfinishedStart(comparison)
    const escapedStart =
      unfinished < comparison.length ? (decoded?.sourceOffset(unfinished) ?? unfinished) : value.length
    const start = Math.min(Math.max(0, value.length - longest + 1), escapedStart)
    // Match complete credentials against the original string, including a
    // credential whose tail is also a prefix of another credential.
    const found = matches(value)
    const lastVisible = found.find(({ start: matchStart, end }) => matchStart < start && end > start)
    return {
      output: replaceMatches(value, found, 0, start),
      withheld: (lastVisible?.end ?? start) < value.length,
    }
  }

  function previewStatus(value: string, limit: number) {
    // Read enough beyond the cap to match any literal crossing it.
    const scan = value.slice(0, limit + lookahead)
    const progress = scan.length === value.length ? progressStatus(scan) : { output: text(scan), withheld: false }
    const truncated = scan.length < value.length || progress.output.length > limit
    return { ...progress, output: truncated ? progress.output.slice(0, limit) + "\n\n..." : progress.output }
  }

  // Binary attachments must stay valid. When their transport or decoded bytes
  // contain an exact credential, omit the bytes and leave a text placeholder.
  let binaryLiterals: Buffer[] | undefined
  const binaryMatches = new Map<string, boolean>()
  function containsCredentialBytes(encoded: string, encoding: "base64" | "percent" = "base64") {
    if (!encoded || !pattern) return false
    // Replay may allocate new attachment objects on every turn. Cache only a
    // digest and a match bit, without retaining the attachment itself.
    const digest =
      encoded.length >= 4096
        ? createHash("sha256").update(encoding).update(encoded, "utf16le").digest("hex")
        : undefined
    const cached = digest ? binaryMatches.get(digest) : undefined
    if (cached !== undefined) return cached
    binaryLiterals ??= ordered.map((literal) => Buffer.from(literal, "utf8"))
    let contains = text(encoded) !== encoded
    if (!contains) {
      const bytes = encoding === "base64" ? Buffer.from(encoded, "base64") : decodePercentBytes(encoded)
      contains = binaryLiterals.some((literal) => bytes.includes(literal))
    }
    if (digest) {
      if (binaryMatches.size >= 64) binaryMatches.clear()
      binaryMatches.set(digest, contains)
    }
    return contains
  }

  function decodePercentBytes(encoded: string) {
    const bytes = Buffer.allocUnsafe(Buffer.byteLength(encoded))
    let offset = 0
    let written = 0
    for (const match of encoded.matchAll(/(?:%[\da-f]{2})+/gi)) {
      written += bytes.write(encoded.slice(offset, match.index), written, "utf8")
      for (let index = 0; index < match[0].length; index += 3) {
        bytes[written++] = Number.parseInt(match[0].slice(index + 1, index + 3), 16)
      }
      offset = match.index + match[0].length
    }
    written += bytes.write(encoded.slice(offset), written, "utf8")
    return bytes.subarray(0, written)
  }

  const omitAttachment = Symbol("omitAttachment")
  function filterMedia(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.type === "file" && typeof item.url === "string") {
      const data = /^data:([^,]*),(.*)$/is.exec(item.url)
      if (data && containsCredentialBytes(data[2], /;base64$/i.test(data[1]) ? "base64" : "percent")) {
        return omitAttachment
      }
    }
    if ((item.type === "image" || item.type === "audio") && typeof item.data === "string") {
      if (containsCredentialBytes(item.data)) return { type: "text", text: replacement }
    }
    if (item.type === "resource" && item.resource && typeof item.resource === "object") {
      const resource = item.resource as Record<string, unknown>
      if (typeof resource.blob === "string" && containsCredentialBytes(resource.blob)) {
        const { blob, ...rest } = resource
        return {
          ...item,
          resource: { ...rest, text: resource.text ? text(String(resource.text)) + "\n" + replacement : replacement },
        }
      }
    }
    return value
  }

  type Frame = "envelope" | "content" | "data"

  function visit(value: unknown, seen: WeakMap<object, unknown>, frame: Frame): unknown {
    if (typeof value === "string") return text(value)
    if (!value || typeof value !== "object") return value
    if (seen.has(value)) return seen.get(value)
    if (Array.isArray(value)) {
      const next: unknown[] = []
      seen.set(value, next)
      let changed = false
      for (const item of value) {
        const filtered = frame === "content" ? filterMedia(item) : item
        if (filtered === omitAttachment) {
          changed = true
          continue
        }
        const safeItem = visit(filtered, seen, frame)
        changed ||= safeItem !== item
        next.push(safeItem)
      }
      if (changed) return next
      seen.set(value, value)
      return value
    }
    if (value instanceof Error) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      // DOMException's name and message live in native slots, not own descriptors.
      const dom = value instanceof DOMException ? new DOMException(text(value.message), text(value.name)) : undefined
      const next = dom ?? Object.create(Object.getPrototypeOf(value))
      seen.set(value, next)
      let changed = !!dom && (dom.message !== value.message || dom.name !== value.name)
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor: PropertyDescriptor = Reflect.get(descriptors, key)
        if (!("value" in descriptor)) continue
        const safe = visit(descriptor.value, seen, "data")
        changed ||= safe !== descriptor.value
        descriptor.value = safe
      }
      if (changed) return Object.defineProperties(next, descriptors)
      seen.set(value, value)
      return value
    }
    const prototype = Object.getPrototypeOf(value)
    const plain = prototype === Object.prototype || prototype === null
    // SDK media and native values such as dates and typed arrays retain their representation.
    if (!plain && Object.prototype.toString.call(value) !== "[object Object]") return value
    const next = Object.create(prototype)
    seen.set(value, next)
    let changed = false
    for (const [key, item] of Object.entries(value)) {
      const childFrame: Frame =
        (frame === "envelope" && (key === "content" || key === "attachments")) ||
        (frame === "content" && key === "resource")
          ? "content"
          : "data"
      const discriminator = frame === "content" && key === "type" && typeof item === "string" && contentKinds.has(item)
      const safeItem = discriminator ? item : visit(item, seen, childFrame)
      changed ||= safeItem !== item
      Object.defineProperty(next, key, {
        value: safeItem,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    if (changed) {
      if (frame === "envelope") {
        const attachments = Object.getOwnPropertyDescriptor(value, "attachments")?.value
        if (
          Array.isArray(attachments) &&
          Array.isArray(next.attachments) &&
          next.attachments.length < attachments.length &&
          typeof next.output === "string"
        ) {
          next.output += "\n" + replacement
        }
      }
      return next
    }
    seen.set(value, value)
    return value
  }

  return {
    failure(error: unknown): unknown {
      return pattern ? visit(error, new WeakMap(), "data") : error
    },
    text,
    multilineLookaround: ordered.find((value) => value.includes("\n"))?.length ?? 0,
    windowLookaround: lookahead,
    lines: (value: string) => replaceMatches(value, matches(value), 0, value.length, true),
    progress: (value: string) => progressStatus(value).output,
    previewStatus,
    preview: (value: string, limit: number) => previewStatus(value, limit).output,
    window(value: string, from: number, to: number) {
      if (!pattern) return value.slice(from, to)
      const start = Math.max(0, from - lookahead)
      const scan = value.slice(start, to + lookahead)
      return replaceMatches(scan, matches(scan), from - start, to - start)
    },
    output<T>(value: T): T {
      return pattern ? (visit(value, new WeakMap(), Array.isArray(value) ? "content" : "envelope") as T) : value
    },
    metadata<T>(value: T): T {
      return pattern ? (visit(value, new WeakMap(), "data") as T) : value
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
const databaseCredentialVariables = new Set(["PGPASSWORD", "MYSQL_PWD"])
const providerLocationVariables = /(?:^|_)(?:REGION|LOCATION|PROJECT|PROJECT_ID|ENDPOINT|BASE_URL|HOST)$/i
const publicCertificateFields = new Set(["ssl_cert", "ssl_ca", "tls_cert", "tls_ca_cert"])

function isCredentialName(name: string) {
  return (
    databaseCredentialVariables.has(name) ||
    /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|AUTHORIZATION)$/i.test(name.replaceAll("-", "_"))
  )
}

function addCredentialHeaders(headers: Record<string, unknown> | undefined, add: AddCredential) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!/(?:^|[-_])(?:authorization|api[-_]?key|(?:auth|access|api|private)[-_]token|client[-_]secret)$/i.test(name)) {
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
  if (typeof value !== "string" || !value || publicCertificateFields.has(name)) return
  if (name === "credentials_json" || name === "keyfile_json") {
    const fields = readJson(value)
    if (fields && typeof fields === "object") {
      addConnectionFields(fields, add)
      return
    }
  }
  if (name === "connection_string") {
    const url = value.includes("://") ? URL.parse(value) : null
    if (url) {
      if (url.password) {
        add(url.password)
        try {
          add(decodeURIComponent(url.password))
        } catch {
          // The encoded password still matches if a percent escape is invalid.
        }
      }
      for (const query of url.search.slice(1).split("&")) {
        for (const [key, field] of new URLSearchParams(query)) {
          const normalized = key.toLowerCase()
          if (normalized !== "pwd" && !isSensitiveField(normalized) && !isCredentialName(normalized)) continue
          add(field)
          add(query.slice(query.indexOf("=") + 1))
        }
      }
      return
    }
    // Connection attributes can be unquoted, quoted or ODBC-braced. Parse
    // only when the entire value is an attribute list.
    const attributes = [
      ...value.matchAll(/\s*([\w -]{1,80}?)\s*=\s*(\{(?:[^}]|}})*}|"(?:[^"]|"")*"|'(?:[^']|'')*'|[^;]*?)\s*(?:;|$)/gy),
    ]
    if (attributes.length && attributes.map((match) => match[0]).join("") === value) {
      for (const [, key, field] of attributes) {
        const normalized = key.trim().toLowerCase()
        if (normalized !== "pwd" && !isSensitiveField(normalized) && !isCredentialName(normalized)) continue
        const delimiter = field[0]
        const closing = delimiter === "{" ? "}" : delimiter
        if (["{", '"', "'"].includes(delimiter) && field.endsWith(closing)) {
          const contents = field.slice(1, -1)
          add(contents)
          add(contents.replaceAll(closing + closing, closing))
        } else {
          add(field)
        }
      }
      return
    }
  }
  add(value)
}

function addConnectionFields(value: unknown, add: AddCredential) {
  if (!value || typeof value !== "object") return
  for (const [key, field] of Object.entries(value)) {
    if (isSensitiveField(key)) addConnectionCredential(key, field, add)
    addConnectionFields(field, add)
  }
}

// The two auth stores are shared across instances. Reuse their last stable
// snapshots, and refresh when a writer or another process changes the file.
function authFileSnapshot<T>() {
  let cached: { version: string; data: Promise<T | undefined> } | undefined
  return async (file: string, load: () => Promise<T>) => {
    const info = await stat(file, { bigint: true }).catch(() => undefined)
    if (!info) {
      cached = undefined
      return undefined
    }
    // Whole-second timestamps cannot distinguish same-size rewrites within a second.
    if (info.mtimeNs % 1_000_000_000n === 0n) {
      cached = undefined
      return load().catch(() => undefined)
    }
    const version = `${file}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    if (cached?.version === version) return cached.data
    const data = load().catch(() => {
      if (cached?.data === data) cached = undefined
      return undefined
    })
    cached = { version, data }
    return data
  }
}

const readProviderAuth = authFileSnapshot<Awaited<ReturnType<typeof import("@/auth").all>>>()
const readMcpAuth = authFileSnapshot<Awaited<ReturnType<typeof import("@/mcp/auth").all>>>()
let lastSnapshot: { values: Set<string>; redactor: CredentialRedactor } | undefined

const collectToolCredentialRedactor = Effect.gen(function* () {
  // Message projection is below configuration and the connection registry in the import graph.
  const [{ Auth }, { Config }, { Env }, Connections, { McpAuth }, { knownMcpHeaders }] = yield* Effect.promise(() =>
    Promise.all([
      import("@/auth"),
      import("@/config/config"),
      import("@/env"),
      import("@/altimate/native/connections/registry"),
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
      process.env.OPENCODE_AUTH_CONTENT
        ? Auth.all().catch(() => undefined)
        : readProviderAuth(Auth.filepath(), Auth.all),
      readMcpAuth(McpAuth.credentialFile, McpAuth.all),
    ]),
  )
  const environment = [...Object.entries(process.env), ...Object.entries(instance ? Env.all() : {})]
  const configuredVariables = new Set<string>()
  for (const provider of Object.values(config?.provider ?? {})) {
    for (const name of provider.env ?? []) {
      if (!providerLocationVariables.test(name)) configuredVariables.add(name)
    }
    addProviderOptions(provider.options, add)
    for (const model of Object.values(provider.models ?? {})) {
      addProviderOptions(model.options, add)
      addCredentialHeaders(model.headers, add)
    }
  }
  for (const [name, value] of environment) {
    if (name.startsWith(Connections.CONN_ENV_PREFIX)) {
      if (value) addConnectionFields(readJson(value), add)
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
    const connections = Connections.knownCredentialConfigs(instance.directory)
    for (const connection of connections) addConnectionFields(connection, add)
  }
  for (const credential of knownStoredCredentials()) addConnectionCredential(credential.field, credential.value, add)
  const previous = lastSnapshot
  if (previous && previous.values.size === values.size && [...values].every((value) => previous.values.has(value))) {
    return previous.redactor
  }
  const redactor = createCredentialRedactor(values)
  lastSnapshot = { values, redactor }
  return redactor
})

export const loadToolCredentialRedactor = Effect.gen(function* () {
  if (yield* InstanceRef) return yield* collectToolCredentialRedactor
  return yield* withAlsInstanceRef(collectToolCredentialRedactor)
})

export function toolCredentialRedactor() {
  return Effect.runPromise(attach(loadToolCredentialRedactor))
}
