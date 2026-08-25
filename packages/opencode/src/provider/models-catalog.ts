// altimate_change start — bot-review fix: models.dev catalog validation.
//
// Split out of models.ts so it can be tested directly. Every path that can
// populate the on-disk cache runs through it: the cold fetch, the hourly
// refresh, and the cache READ (an entry poisoned by an older build must not be
// trusted either).
//
// A 2xx body being valid JSON does not make it the catalog. `null`, `[]`, a
// scalar and an object-shaped error payload (`{"error": "rate limited"}`) all
// survive JSON.parse, and a misconfigured proxy returns exactly those with a
// JSON content-type. Caching one poisons the cache for the whole TTL, and
// `Provider.state` then maps over it reading `provider.models` / `provider.id`.
//
// This is a STRUCTURAL check, deliberately NOT the zod `Provider` schema. A
// review suggested the schema and it looked right, but `Provider.safeParse`
// rejects 0 of the 144 providers in our own bundled snapshot: `Model` requires
// an `options` record that real models.dev entries do not carry. Gating the
// cache on it meant nothing was ever cached and every load fell through to a
// network fetch, which hangs in sandboxed CI. So the check asserts only what
// consumers actually rely on: a non-empty map whose values are provider objects
// carrying a `models` map.
//
// Module shape follows packages/opencode/AGENTS.md: flat exports plus a
// self-reexport, not `export namespace`.

/** True when `value` is shaped like a models.dev catalog rather than junk. */
export function isCatalog(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entries = Object.values(value)
  if (entries.length === 0) return false
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
    const models = Reflect.get(entry, "models")
    return !!models && typeof models === "object" && !Array.isArray(models)
  })
}

/** Parse a models.dev response body, returning undefined unless it is a catalog. */
export function parseCatalog(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isCatalog(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export * as ModelsCatalog from "./models-catalog"
// altimate_change end
