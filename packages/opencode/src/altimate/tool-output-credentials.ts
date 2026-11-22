// altimate_change — redact only exact known credential values in tool results.
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { attach } from "@/effect/run-service"
import { withAlsInstanceRef } from "@/altimate/tool-zod-compat"
import { isSensitiveField, knownStoredCredentials } from "@/altimate/native/connections/credential-store"

const replacement = "[REDACTED]"
const minLength = 8

export function createCredentialRedactor(values: Iterable<string | undefined> = []) {
  const literals = new Set<string>()
  for (const value of values) {
    if (!value || value.length < minLength) continue
    literals.add(value)
    literals.add(JSON.stringify(value).slice(1, -1))
  }
  const ordered = [...literals].sort((a, b) => b.length - a.length)
  const pattern = ordered.length ? new RegExp(ordered.map((value) => RegExp.escape(value)).join("|"), "g") : undefined
  const maxLiteralLength = ordered[0]?.length ?? 0
  const text = (value: string) => (pattern ? value.replace(pattern, replacement) : value)
  const lines = (value: string) =>
    pattern ? value.replace(pattern, (match) => replacement + "\n".repeat(match.split("\n").length - 1)) : value

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
      Object.defineProperty(next, text(key), {
        value: visit(item, seen),
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
    lines,
    preview(value: string, limit: number) {
      // Check the lookahead so a literal crossing the preview limit is still removed.
      const prefix = text(value.slice(0, limit + maxLiteralLength))
      return value.length > limit + maxLiteralLength || prefix.length > limit
        ? prefix.slice(0, limit) + "\n\n..."
        : prefix
    },
    output<T>(value: T): T {
      return pattern ? (visit(value, new WeakMap()) as T) : value
    },
  }
}

export type CredentialRedactor = ReturnType<typeof createCredentialRedactor>

function addConnectionFields(value: unknown, add: (value: unknown) => void) {
  if (!value || typeof value !== "object") return
  for (const [key, field] of Object.entries(value)) {
    if (isSensitiveField(key)) add(field)
    if (field && typeof field === "object") addConnectionFields(field, add)
  }
}

export const loadToolCredentialRedactor = withAlsInstanceRef(
  Effect.gen(function* () {
    // Message projection is below configuration and the connection registry in the import graph.
    const [{ Auth }, { Config }, { Env }, Connections, { Instance }] = yield* Effect.promise(() =>
      Promise.all([
        import("@/auth"),
        import("@/config/config"),
        import("@/env"),
        import("@/altimate/native/connections/registry"),
        import("@/project/instance"),
      ]),
    )
    const instance = yield* InstanceRef
    const values = new Set<string>()
    const add = (value: unknown) => {
      if (typeof value === "string") values.add(value)
    }
    const [config, auth] = yield* Effect.promise(() =>
      Promise.all([instance ? Config.get().catch(() => undefined) : undefined, Auth.all().catch(() => undefined)]),
    )
    const environment = [...Object.entries(process.env), ...Object.entries(instance ? Env.all() : {})]
    const configuredVariables = new Set<string>()
    for (const provider of Object.values(config?.provider ?? {})) {
      for (const name of provider.env ?? []) configuredVariables.add(name)
      add(provider.options?.apiKey)
      for (const model of Object.values(provider.models ?? {})) add(model.options?.apiKey)
    }
    for (const [name, value] of environment) {
      if (name.startsWith(Connections.CONN_ENV_PREFIX)) {
        add(value)
        if (value) {
          try {
            addConnectionFields(JSON.parse(value), add)
          } catch {
            // The complete environment value is still a known literal.
          }
        }
      } else if (/(?:^|_)API_KEY$/i.test(name) || configuredVariables.has(name)) {
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
    if (instance) {
      const connections = Instance.restore(instance, () => Connections.knownCredentialConfigs())
      for (const connection of connections) addConnectionFields(connection, add)
    }
    for (const credential of knownStoredCredentials()) add(credential)
    return createCredentialRedactor(values)
  }),
)

export function toolCredentialRedactor() {
  return Effect.runPromise(attach(loadToolCredentialRedactor))
}
